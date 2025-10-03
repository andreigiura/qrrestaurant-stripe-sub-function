# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js serverless function for handling Stripe subscription payments with Appwrite integration. The function manages subscription checkouts and webhooks, granting/revoking "subscriber" labels to users based on their subscription status.

## Commands

- **Format code**: `npm run format`
- **Install dependencies**: `npm install`

## Architecture

### Deployment Context
This is an **Appwrite Function** designed to run as a serverless function. It expects:
- Runtime: Node.js 18.0
- Entrypoint: `src/main.js`
- Build command: `npm install`
- Timeout: 15 seconds

### Request Flow

The main handler (`src/main.js`) routes requests based on path:

1. **GET /**: Returns static HTML demo page (`static/index.html`) with environment variable interpolation
2. **POST /subscribe**: Creates Stripe checkout session, redirects user to payment
3. **POST /webhook**: Validates and processes Stripe webhook events

### Core Services

- **StripeService** (`src/stripe.js`): Handles Stripe API operations
  - `checkoutSubscription()`: Creates subscription checkout session with $10/month pricing
  - `validateWebhook()`: Validates incoming Stripe webhook signatures using `req.bodyBinary`

- **AppwriteService** (`src/appwrite.js`): Manages user labels via Appwrite Users API
  - `createSubscription()`: Adds "subscriber" label to user
  - `deleteSubscription()`: Removes "subscriber" label from user
  - Initialized with API key from `x-appwrite-key` header

### User Identification

- User ID is passed via `x-appwrite-user-id` header for `/subscribe` endpoint
- For webhooks, user ID is retrieved from `session.metadata.userId` attached during checkout

### Environment Variables

Required environment variables (validated on startup via `throwIfMissing()`):
- `STRIPE_SECRET_KEY`: Stripe API authentication
- `STRIPE_WEBHOOK_SECRET`: Webhook signature validation
- Auto-injected by Appwrite: `APPWRITE_FUNCTION_API_ENDPOINT`, `APPWRITE_FUNCTION_PROJECT_ID`, `APPWRITE_FUNCTION_ID`

### Webhook Events

Only two Stripe events are processed:
- `customer.subscription.created`: Grants "subscriber" label
- `customer.subscription.deleted`: Revokes "subscriber" label
