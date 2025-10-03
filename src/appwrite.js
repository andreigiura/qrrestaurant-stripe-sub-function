import { Client, Users } from 'node-appwrite';

const PLAN_LABELS = {
  starter: 'planstarter',
  growth: 'plangrowth',
  pro: 'planpro',
};

class AppwriteService {
  constructor(apiKey) {
    const client = new Client();
    client
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(apiKey);

    this.users = new Users(client);
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
}

export default AppwriteService;
