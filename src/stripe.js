/// <reference types="stripe-event-types" />

import stripe from 'stripe';

const PRICE_IDS = {
  starter: {
    monthly: 'price_1SEA2XEJ7AJnPOEgNxxySxGq',
    annual: 'price_1SEA3oEJ7AJnPOEgE899Ni3D',
  },
  growth: {
    monthly: 'price_1SEA2wEJ7AJnPOEgTLJ5zFpI',
    annual: 'price_1SEA5tEJ7AJnPOEgc7DzoIno',
  },
  pro: {
    monthly: 'price_1SEA3HEJ7AJnPOEgMK5YZsfX',
    annual: 'price_1SEA6VEJ7AJnPOEgvUWT5ci7',
  },
};

class StripeService {
  constructor() {
    // Note: stripe cjs API types are faulty
    /** @type {import('stripe').Stripe} */
    // @ts-ignore
    this.client = stripe(process.env.STRIPE_SECRET_KEY);
  }

  /**
   * @param {string} userId
   * @param {string} planType - 'starter', 'growth', or 'pro'
   * @param {string} billingInterval - 'monthly' or 'annual'
   * @param {string} successUrl
   * @param {string} failureUrl
   */
  async checkoutSubscription(context, userId, planType, billingInterval, successUrl, failureUrl) {
    const priceId = PRICE_IDS[planType]?.[billingInterval];
    if (!priceId) {
      context.error(`Invalid plan type or billing interval: ${planType} ${billingInterval}`);
      return null;
    }

    try {
      context.log(`Creating Stripe session with price: ${priceId}, success_url: ${successUrl}, cancel_url: ${failureUrl}`);

      const session = await this.client.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: failureUrl,
        client_reference_id: userId,
        subscription_data: {
          metadata: {
            userId,
            planType,
            billingInterval,
          },
        },
        mode: 'subscription',
      });

      context.log(`Stripe session created with ID: ${session.id}, actual success_url: ${session.success_url}`);
      return session;
    } catch (err) {
      context.error(err);
      return null;
    }
  }

  /**
   * @param {string} customerId
   * @param {string} returnUrl
   */
  async createPortalSession(context, customerId, returnUrl) {
    try {
      context.log(`Creating Stripe portal session for customer: ${customerId}`);

      const session = await this.client.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      context.log(`Portal session created: ${session.url}`);
      return session;
    } catch (err) {
      context.error(err);
      return null;
    }
  }

  /**
   * @returns {import("stripe").Stripe.DiscriminatedEvent | null}
   */
  validateWebhook(context, req) {
    try {
      const event = this.client.webhooks.constructEvent(
        req.bodyBinary,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
      return /** @type {import("stripe").Stripe.DiscriminatedEvent} */ (event);
    } catch (err) {
      context.error(err);
      return null;
    }
  }
}

export default StripeService;
