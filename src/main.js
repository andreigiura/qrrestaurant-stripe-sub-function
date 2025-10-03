import StripeService from './stripe.js';
import AppwriteService from './appwrite.js';
import { getStaticFile, interpolate, throwIfMissing } from './utils.js';

export default async (context) => {
  const { req, res, log, error } = context;

  throwIfMissing(process.env, [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]);

  if (req.method === 'GET') {
    const html = interpolate(getStaticFile('index.html'), {
      APPWRITE_FUNCTION_API_ENDPOINT: process.env.APPWRITE_FUNCTION_API_ENDPOINT,
      APPWRITE_FUNCTION_PROJECT_ID: process.env.APPWRITE_FUNCTION_PROJECT_ID,
      APPWRITE_FUNCTION_ID: process.env.APPWRITE_FUNCTION_ID,
    });

    return res.text(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  const appwrite = new AppwriteService(context.req.headers['x-appwrite-key']);
  const stripe = new StripeService();

  switch (req.path) {
    case '/subscribe':
      const fallbackUrl = req.scheme + '://' + req.headers['host'] + '/';

      // Parse body if it's a string
      let bodyData = req.body;
      if (typeof bodyData === 'string') {
        try {
          bodyData = JSON.parse(bodyData);
        } catch (e) {
          error('Failed to parse request body');
          bodyData = {};
        }
      }

      const successUrl = bodyData?.successUrl ?? fallbackUrl;
      const failureUrl = bodyData?.failureUrl ?? fallbackUrl;
      const planType = bodyData?.planType || 'starter';
      const billingInterval = bodyData?.billingInterval || 'monthly';

      log(`Received subscription request - successUrl: ${successUrl}, failureUrl: ${failureUrl}, planType: ${planType}, billingInterval: ${billingInterval}`);

      // Validate plan type
      if (!['starter', 'growth', 'pro'].includes(planType)) {
        error(`Invalid plan type: ${planType}`);
        return res.redirect(failureUrl, 303);
      }

      // Validate billing interval
      if (!['monthly', 'annual'].includes(billingInterval)) {
        error(`Invalid billing interval: ${billingInterval}`);
        return res.redirect(failureUrl, 303);
      }

      const userId = req.headers['x-appwrite-user-id'];
      if (!userId) {
        error('User ID not found in request.');
        return res.redirect(failureUrl, 303);
      }

      const session = await stripe.checkoutSubscription(
        context,
        userId,
        planType,
        billingInterval,
        successUrl,
        failureUrl
      );
      if (!session) {
        error('Failed to create Stripe checkout session.');
        return res.redirect(failureUrl, 303);
      }

      context.log('Session:');
      context.log(session);

      log(`Created Stripe checkout session for user ${userId} with plan ${planType} (${billingInterval}).`);
      return res.redirect(session.url, 303);

    case '/portal':
      // Parse body if it's a string
      let portalBodyData = req.body;
      if (typeof portalBodyData === 'string') {
        try {
          portalBodyData = JSON.parse(portalBodyData);
        } catch (e) {
          error('Failed to parse request body');
          portalBodyData = {};
        }
      }

      const portalUserId = req.headers['x-appwrite-user-id'];
      if (!portalUserId) {
        error('User ID not found in request.');
        return res.json({ success: false, error: 'User ID required' }, 400);
      }

      const returnUrl = portalBodyData?.returnUrl || req.scheme + '://' + req.headers['host'] + '/';

      // Get Stripe customer ID from user preferences
      let customerId = await appwrite.getStripeCustomerId(portalUserId);

      if (!customerId) {
        error(`No Stripe customer found for user ${portalUserId}`);
        return res.json({ success: false, error: 'No active subscription found' }, 404);
      }

      const portalSession = await stripe.createPortalSession(context, customerId, returnUrl);
      if (!portalSession) {
        error('Failed to create Stripe portal session.');
        return res.json({ success: false, error: 'Failed to create portal session' }, 500);
      }

      log(`Created Stripe portal session for user ${portalUserId}`);
      return res.redirect(portalSession.url, 303);

    case '/subscription':
      // Get subscription details for the current user
      const subUserId = req.headers['x-appwrite-user-id'];
      if (!subUserId) {
        return res.json({ success: false, error: 'User ID required' }, 400);
      }

      const subCustomerId = await appwrite.getStripeCustomerId(subUserId);
      if (!subCustomerId) {
        return res.json({ success: false, error: 'No subscription found' }, 404);
      }

      const subscriptionDetails = await stripe.getSubscriptionDetails(context, subCustomerId);
      if (!subscriptionDetails) {
        return res.json({ success: false, error: 'Failed to fetch subscription details' }, 500);
      }

      log(`Retrieved subscription details for user ${subUserId}`);
      return res.json({ success: true, data: subscriptionDetails });

    case '/sync-customer':
      // Helper endpoint to sync existing Stripe customers
      // This finds the customer by email and stores their ID
      const syncUserId = req.headers['x-appwrite-user-id'];
      if (!syncUserId) {
        return res.json({ success: false, error: 'User ID required' }, 400);
      }

      try {
        const user = await appwrite.users.get(syncUserId);
        const userEmail = user.email;

        if (!userEmail) {
          return res.json({ success: false, error: 'User has no email' }, 400);
        }

        // Search for customer in Stripe by email
        const customers = await stripe.client.customers.list({
          email: userEmail,
          limit: 1
        });

        if (customers.data.length > 0) {
          const customer = customers.data[0];
          await appwrite.setStripeCustomerId(syncUserId, customer.id);
          log(`Synced Stripe customer ${customer.id} for user ${syncUserId}`);
          return res.json({ success: true, customerId: customer.id });
        } else {
          return res.json({ success: false, error: 'No Stripe customer found with this email' }, 404);
        }
      } catch (err) {
        error(err);
        return res.json({ success: false, error: err.message }, 500);
      }

    case '/webhook':
      const event = stripe.validateWebhook(context, req);
      if (!event) {
        return res.json({ success: false }, 401);
      }

      context.log('Event:');
      context.log(event);

      if (event.type === 'customer.subscription.created') {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const planType = session.metadata.planType || 'starter';
        const customerId = session.customer;

        // Store Stripe customer ID if not already stored
        const existingCustomerId = await appwrite.getStripeCustomerId(userId);
        if (!existingCustomerId && customerId) {
          await appwrite.setStripeCustomerId(userId, customerId);
          log(`Stored Stripe customer ID for user ${userId}`);
        }

        await appwrite.createSubscription(userId, planType);
        log(`Created ${planType} subscription for user ${userId}`);
        return res.json({ success: true });
      }

      if (event.type === 'customer.subscription.deleted') {
        const session = event.data.object;
        const userId = session.metadata.userId;

        await appwrite.deleteSubscription(userId);
        log(`Deleted subscription for user ${userId}`);

        // Deactivate ALL tables when subscription is deleted
        const enforcementResult = await appwrite.enforceTableLimits(context, userId, null);
        log(`Table limits enforcement result: ${JSON.stringify(enforcementResult)}`);

        return res.json({ success: true });
      }

      if (event.type === 'customer.subscription.updated') {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const planType = session.metadata.planType || 'starter';
        const status = session.status; // active, canceled, past_due, etc.
        const customerId = session.customer;

        log(`Subscription updated for user ${userId}: status=${status}, planType=${planType}`);

        // Only apply subscription if it's active
        // If canceled/incomplete/past_due, treat as no subscription
        if (status === 'active' || status === 'trialing') {
          // Update customer ID in case it changed (e.g., new subscription after cancellation)
          const existingCustomerId = await appwrite.getStripeCustomerId(userId);
          if (existingCustomerId !== customerId) {
            await appwrite.setStripeCustomerId(userId, customerId);
            log(`Updated Stripe customer ID for user ${userId}: ${existingCustomerId} -> ${customerId}`);
          }

          await appwrite.createSubscription(userId, planType);
          log(`Updated to ${planType} subscription for user ${userId}`);

          // Enforce table limits after subscription update
          const enforcementResult = await appwrite.enforceTableLimits(context, userId, planType);
          log(`Table limits enforcement result: ${JSON.stringify(enforcementResult)}`);
        } else {
          // Subscription is canceled, incomplete, or past_due - remove subscription
          await appwrite.deleteSubscription(userId);
          log(`Removed subscription for user ${userId} (status: ${status})`);

          // Enforce limits as if no subscription
          const enforcementResult = await appwrite.enforceTableLimits(context, userId, null);
          log(`Table limits enforcement result: ${JSON.stringify(enforcementResult)}`);
        }

        return res.json({ success: true });
      }

      return res.json({ success: true });

    default:
      return res.text('Not Found', 404);
  }
};
