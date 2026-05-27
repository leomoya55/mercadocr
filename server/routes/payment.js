const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/user.model');
const { verifyToken } = require('../middleware/auth');

// Create checkout session — auth required
router.post('/create-checkout-session', verifyToken, async (req, res) => {
  const uid = req.uid;
  const { type } = req.body;
  if (!type) return res.status(400).json({ error: 'Missing type' });
  if (!['single', 'basic', 'pro'].includes(type)) return res.status(400).json({ error: 'Invalid payment type' });

  try {
    // Single post: one-time ₡500 payment
    if (type === 'single') {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'crc',
            product_data: {
              name: 'Publicación adicional - MercadoCR',
              description: '1 publicación adicional en MercadoCR.',
            },
            unit_amount: 50000, // ₡500 in CRC centimos
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: `${req.headers.origin}/publish?payment_success=true&type=single`,
        cancel_url: `${req.headers.origin}/publish?payment_canceled=true`,
        metadata: { uid, type: 'single' },
      });
      return res.json({ id: session.id, url: session.url });
    }

    // Basic / Pro: monthly subscription
    const isPro = type === 'pro';
    const priceData = {
      currency: 'crc',
      product_data: {
        name: isPro ? 'Suscripcion Pro MercadoCR' : 'Suscripcion Basic MercadoCR',
        description: isPro
          ? 'Plan Pro mensual con anuncios ilimitados y destacados.'
          : 'Plan Basic mensual con hasta 25 anuncios activos.',
      },
      unit_amount: isPro ? 1000000 : 500000,
      recurring: { interval: 'month' },
    };
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: priceData, quantity: 1 }],
      mode: 'subscription',
      success_url: `${req.headers.origin}/pricing?payment_success=true&type=${type}`,
      cancel_url: `${req.headers.origin}/publish?payment_canceled=true`,
      metadata: { uid, type },
      subscription_data: { metadata: { uid, type } },
    });
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: 'Failed to create Stripe session' });
  }
});

// Stripe webhook — verified by Stripe signature, not Firebase token
router.post('/webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(400).send('Missing webhook secret');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  try {
    // Single post payment: add 1 credit to the user
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'payment' && session.metadata?.type === 'single') {
        const uid = session.metadata.uid;
        await User.findOneAndUpdate(
          { firebaseUid: uid },
          { $inc: { singlePostCredits: 1 } }
        );
      }
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const uid = subscription.metadata.uid;
      const plan = subscription.metadata.type;
      const planExpiresAt = new Date(subscription.current_period_end * 1000);
      await User.findOneAndUpdate(
        { firebaseUid: uid },
        { plan, planExpiresAt, stripeCustomerId: subscription.customer, stripeSubscriptionId: subscription.id },
        { new: true }
      );
      if (plan === 'pro') {
        const Listing = require('../models/listing.model');
        await Listing.updateMany({ author: uid }, { featured: true });
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const uid = subscription.metadata.uid;
      const Listing = require('../models/listing.model');
      await User.findOneAndUpdate(
        { firebaseUid: uid },
        { plan: 'free', planExpiresAt: null, stripeSubscriptionId: null },
        { new: true }
      );
      await Listing.updateMany({ author: uid }, { featured: false });
    }
    if (event.type === 'invoice.payment_failed') {
      console.error('Payment failed for subscription:', event.data.object.subscription);
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});

// Cancel subscription at period end — auth required
router.post('/cancel-subscription', verifyToken, async (req, res) => {
  const uid = req.uid;
  const user = await User.findOne({ firebaseUid: uid });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.stripeSubscriptionId) return res.status(400).json({ error: 'No active subscription' });

  try {
    await stripe.subscriptions.update(user.stripeSubscriptionId, { cancel_at_period_end: true });
    user.plan = 'free';
    user.stripeSubscriptionId = null;
    user.planExpiresAt = null;
    await user.save();
    const Listing = require('../models/listing.model');
    await Listing.updateMany({ author: uid }, { featured: false });
    res.json({ success: true });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
