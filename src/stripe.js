/// <reference types="stripe-event-types" />

import stripe from 'stripe';

const PLANS = {
  starter: {
    name: 'Starter Plan',
    monthly: 4900, // $49.00
    annual: 4400, // $44.00
  },
  growth: {
    name: 'Growth Plan',
    monthly: 9900, // $99.00
    annual: 8900, // $89.00
  },
  pro: {
    name: 'Pro Plan',
    monthly: 19900, // $199.00
    annual: 17900, // $179.00
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
    const plan = PLANS[planType];
    if (!plan) {
      context.error(`Invalid plan type: ${planType}`);
      return null;
    }

    const amount = billingInterval === 'annual' ? plan.annual : plan.monthly;
    const interval = billingInterval === 'annual' ? 'year' : 'month';

    /** @type {import('stripe').Stripe.Checkout.SessionCreateParams.LineItem} */
    const lineItem = {
      price_data: {
        unit_amount: amount,
        currency: 'usd',
        recurring: {
          interval: interval,
        },
        product_data: {
          name: plan.name,
        },
      },
      quantity: 1,
    };

    try {
      context.log(`Creating Stripe session with success_url: ${successUrl}, cancel_url: ${failureUrl}`);

      const session = await this.client.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [lineItem],
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
