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
   * Get table limits for subscription tier
   * @param {string|null} subscription
   * @returns {number} - Max tables allowed (0 for no subscription, -1 for unlimited)
   */
  getTableLimit(subscription) {
    const limits = {
      starter: 15,
      growth: 30,
      pro: -1, // unlimited
    };
    return limits[subscription] || 0;
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
      const limit = this.getTableLimit(newSubscription);

      context.log(`Enforcing table limits for user ${userId}: subscription=${newSubscription}, limit=${limit}`);

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

      context.log(`Found ${activeTables.length} active tables out of ${allTables.length} total`);

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
          message: `Deactivated all ${activeTables.length} tables (no active subscription)`,
        };
      }

      // Unlimited plan - no action needed
      if (limit === -1) {
        context.log('Pro plan - unlimited tables');
        return {
          success: true,
          deactivated: 0,
          message: 'Pro plan has unlimited tables',
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
          deactivatedIds,
          message: `Deactivated ${deactivatedIds.length} tables (downgrade to ${newSubscription})`,
        };
      }

      // Under or at limit - no action needed
      context.log(`User is within limits (${activeTables.length}/${limit} tables)`);
      return {
        success: true,
        deactivated: 0,
        message: `User is within limits (${activeTables.length}/${limit} tables)`,
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
