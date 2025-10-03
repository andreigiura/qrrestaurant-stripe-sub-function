import { Client, Users, Databases } from 'node-appwrite';

const PLAN_LABELS = {
  starter: 'planstarter',
  growth: 'plangrowth',
  pro: 'planpro',
};

const DATABASE_ID = 'main_database';
const TABLES_COLLECTION = 'tables';

class AppwriteService {
  constructor(apiKey) {
    const client = new Client();
    client
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(apiKey);

    this.users = new Users(client);
    this.databases = new Databases(client);
  }

  /**
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async deleteSubscription(userId) {
    const user = await this.users.get(userId);
    const labels = user.labels.filter(
      (label) => !Object.values(PLAN_LABELS).includes(label)
    );

    await this.users.updateLabels(userId, labels);
  }

  /**
   * @param {string} userId
   * @param {string} planType - 'starter', 'growth', or 'pro'
   * @returns {Promise<void>}
   */
  async createSubscription(userId, planType) {
    const planLabel = PLAN_LABELS[planType];
    if (!planLabel) {
      throw new Error(`Invalid plan type: ${planType}`);
    }

    const user = await this.users.get(userId);
    // Remove any existing plan labels
    const labels = user.labels.filter(
      (label) => !Object.values(PLAN_LABELS).includes(label)
    );
    // Add the new plan label
    labels.push(planLabel);

    await this.users.updateLabels(userId, labels);
  }

  /**
   * Get Stripe customer ID from user preferences
   * @param {string} userId
   * @returns {Promise<string|null>}
   */
  async getStripeCustomerId(userId) {
    try {
      const user = await this.users.get(userId);
      return user.prefs?.stripeCustomerId || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Store Stripe customer ID in user preferences
   * @param {string} userId
   * @param {string} customerId
   * @returns {Promise<void>}
   */
  async setStripeCustomerId(userId, customerId) {
    const user = await this.users.get(userId);
    const prefs = user.prefs || {};
    prefs.stripeCustomerId = customerId;
    await this.users.updatePrefs(userId, prefs);
  }

  /**
   * Get user's current subscription tier from labels
   * @param {string} userId
   * @returns {Promise<string|null>}
   */
  async getUserSubscription(userId) {
    try {
      const user = await this.users.get(userId);
      if (!user || !user.labels) return null;

      if (user.labels.includes(PLAN_LABELS.pro)) return 'pro';
      if (user.labels.includes(PLAN_LABELS.growth)) return 'growth';
      if (user.labels.includes(PLAN_LABELS.starter)) return 'starter';

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if user is in trial period (14 days from account creation)
   * @param {Object} user - User object from Appwrite
   * @returns {boolean}
   */
  isInTrialPeriod(user) {
    if (!user || !user.$createdAt) return false;

    const accountCreatedAt = new Date(user.$createdAt);
    const now = new Date();
    const daysSinceCreation = (now - accountCreatedAt) / (1000 * 60 * 60 * 24);

    return daysSinceCreation <= 14;
  }

  /**
   * Get table limits for subscription tier
   * @param {string|null} subscription
   * @param {Object} user - User object (to check trial status)
   * @returns {number} - Max tables allowed (0 for no subscription, -1 for unlimited)
   */
  getTableLimit(subscription, user = null) {
    const limits = {
      starter: 15,
      growth: 30,
      pro: -1, // unlimited
    };

    // If user has a paid subscription, return that limit
    if (subscription && limits[subscription] !== undefined) {
      return limits[subscription];
    }

    // No subscription - check if in trial period
    if (user && this.isInTrialPeriod(user)) {
      return 1; // Trial: 1 table allowed
    }

    return 0; // No subscription and trial expired = 0 tables
  }

  /**
   * Enforce table limits for a user based on their subscription
   * Deactivates excess tables if over limit (LIFO - newest first)
   * @param {Object} context - Appwrite function context for logging
   * @param {string} userId
   * @param {string|null} newSubscription - The new subscription tier
   * @returns {Promise<Object>} - Result with deactivation count
   */
  async enforceTableLimits(context, userId, newSubscription) {
    try {
      // Get user info for trial check
      const user = await this.users.get(userId);
      const limit = this.getTableLimit(newSubscription, user);
      const isInTrial = this.isInTrialPeriod(user);

      context.log(`Enforcing table limits for user ${userId}: subscription=${newSubscription}, limit=${limit}, trial=${isInTrial}`);

      // Get all tables for this user
      const { Query } = await import('node-appwrite');
      const tablesResponse = await this.databases.listDocuments(
        DATABASE_ID,
        TABLES_COLLECTION,
        [
          Query.equal('ownerId', userId),
          Query.orderDesc('$createdAt'),
          Query.limit(100)
        ]
      );

      const allTables = tablesResponse.documents;
      const activeTables = allTables.filter(t => t.active === true);
      const inactiveTables = allTables.filter(t => t.active === false);

      context.log(`Found ${activeTables.length} active and ${inactiveTables.length} inactive tables out of ${allTables.length} total`);

      // No subscription or limit is 0 - deactivate ALL tables
      if (limit === 0) {
        context.log(`No subscription - deactivating all ${activeTables.length} tables`);

        for (const table of activeTables) {
          await this.databases.updateDocument(
            DATABASE_ID,
            TABLES_COLLECTION,
            table.$id,
            { active: false }
          );
        }

        return {
          success: true,
          deactivated: activeTables.length,
          reactivated: 0,
          message: `Deactivated all ${activeTables.length} tables (no active subscription)`,
        };
      }

      // Unlimited plan - reactivate ALL tables
      if (limit === -1) {
        context.log('Pro plan - unlimited tables, reactivating all inactive tables');

        const reactivatedIds = [];
        for (const table of inactiveTables) {
          await this.databases.updateDocument(
            DATABASE_ID,
            TABLES_COLLECTION,
            table.$id,
            { active: true }
          );
          reactivatedIds.push(table.$id);
        }

        return {
          success: true,
          deactivated: 0,
          reactivated: reactivatedIds.length,
          reactivatedIds,
          message: `Reactivated ${reactivatedIds.length} tables (Pro plan - unlimited)`,
        };
      }

      // If over limit, deactivate excess tables (LIFO - newest first)
      if (activeTables.length > limit) {
        const excessCount = activeTables.length - limit;
        context.log(`Over limit by ${excessCount} - deactivating newest tables`);

        const tablesToDeactivate = activeTables.slice(0, excessCount);
        const deactivatedIds = [];

        for (const table of tablesToDeactivate) {
          await this.databases.updateDocument(
            DATABASE_ID,
            TABLES_COLLECTION,
            table.$id,
            { active: false }
          );
          deactivatedIds.push(table.$id);
        }

        return {
          success: true,
          deactivated: deactivatedIds.length,
          reactivated: 0,
          deactivatedIds,
          message: `Deactivated ${deactivatedIds.length} tables (downgrade to ${newSubscription})`,
        };
      }

      // Under limit - reactivate tables up to the limit (FIFO - oldest inactive first)
      if (activeTables.length < limit && inactiveTables.length > 0) {
        const availableSlots = limit - activeTables.length;
        const tablesToReactivate = inactiveTables
          .sort((a, b) => new Date(a.$createdAt) - new Date(b.$createdAt)) // Oldest first
          .slice(0, availableSlots);

        context.log(`Under limit - reactivating ${tablesToReactivate.length} oldest inactive tables`);

        const reactivatedIds = [];
        for (const table of tablesToReactivate) {
          await this.databases.updateDocument(
            DATABASE_ID,
            TABLES_COLLECTION,
            table.$id,
            { active: true }
          );
          reactivatedIds.push(table.$id);
        }

        return {
          success: true,
          deactivated: 0,
          reactivated: reactivatedIds.length,
          reactivatedIds,
          message: `Reactivated ${reactivatedIds.length} tables (upgrade to ${newSubscription})`,
        };
      }

      // At limit - no action needed
      context.log(`User is at limits (${activeTables.length}/${limit} tables)`);
      return {
        success: true,
        deactivated: 0,
        reactivated: 0,
        message: `User is at limits (${activeTables.length}/${limit} tables)`,
      };
    } catch (error) {
      context.error('Error enforcing table limits:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

export default AppwriteService;
