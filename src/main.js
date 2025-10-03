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

      const successUrl = req.body?.successUrl ?? fallbackUrl;
      const failureUrl = req.body?.failureUrl ?? fallbackUrl;
      const planType = req.body?.planType || 'starter';
      const billingInterval = req.body?.billingInterval || 'monthly';

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

        await appwrite.createSubscription(userId, planType);
        log(`Created ${planType} subscription for user ${userId}`);
        return res.json({ success: true });
      }

      if (event.type === 'customer.subscription.deleted') {
        const session = event.data.object;
        const userId = session.metadata.userId;

        await appwrite.deleteSubscription(userId);
        log(`Deleted subscription for user ${userId}`);
        return res.json({ success: true });
      }

      if (event.type === 'customer.subscription.updated') {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const planType = session.metadata.planType || 'starter';

        await appwrite.createSubscription(userId, planType);
        log(`Updated to ${planType} subscription for user ${userId}`);
        return res.json({ success: true });
      }

      return res.json({ success: true });

    default:
      return res.text('Not Found', 404);
  }
};
