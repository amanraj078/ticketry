# Ticketry — Event Ticketing Platform

A full-stack event ticketing platform built with Next.js, Convex, Stripe, and Clerk.

Ticketry allows users to browse events, purchase tickets securely, join waiting lists for sold-out events, and manage tickets with QR-based validation. Sellers can create events, track sales, and manage attendees through a dashboard.

---

## Features

### User Features
- Browse upcoming and past events
- Secure ticket purchasing with Stripe Checkout
- QR code ticket generation
- View and manage purchased tickets
- Join waiting lists for sold-out events
- Real-time ticket updates

### Seller Features
- Create and manage events
- Upload event images
- Track ticket sales and revenue
- Monitor attendee counts
- Manage event inventory

### System Features
- Rate-limited waiting list system
- Real-time backend updates using Convex
- Stripe webhook integration
- Authentication with Clerk
- Server-side rendering with Next.js App Router
- Responsive UI with Tailwind CSS

---

## Tech Stack

### Frontend
- Next.js 15
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- React Hook Form
- Zod

### Backend
- Convex
- Convex Database
- Convex Server Functions

### Authentication & Payments
- Clerk
- Stripe

---

## Architecture

```txt
Client (Next.js)
        │
        ▼
Convex Functions & Database
        │
        ├── Clerk Authentication
        ├── Stripe Checkout + Webhooks
        └── Real-time Updates
```

---

## Core Functionality

### Ticket Purchase Flow

```txt
User selects event
       ↓
Stripe Checkout Session
       ↓
Stripe Webhook Triggered
       ↓
Ticket Generated
       ↓
QR Code Issued
```

### Waiting List Flow

```txt
Event Sold Out
       ↓
User Joins Waiting List
       ↓
Spot Becomes Available
       ↓
Queue Processed Automatically
       ↓
Next User Gets Access
```

---

## Database Design

Main collections:
- `events`
- `tickets`
- `users`
- `waitingList`

Key relationships:
- One seller → many events
- One event → many tickets
- One user → many purchased tickets

---

## Local Development Setup

### Prerequisites
- Node.js 18+
- npm
- Convex account
- Clerk account
- Stripe account

---

### Installation

Clone the repository:

```bash
git clone <your-repo-url>
cd ticketry
```

Install dependencies:

```bash
npm install
```

---

### Environment Variables

Create a `.env.local` file:

```env
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# Stripe
STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=

# Convex
CONVEX_DEPLOYMENT=
NEXT_PUBLIC_CONVEX_URL=

# App URL
VERCEL_PROJECT_PRODUCTION_URL=
```

---

### Run the Application

Start Next.js:

```bash
npm run dev
```

Start Convex dev server in another terminal:

```bash
npx convex dev
```

Open:

```txt
http://localhost:3000
```

---

## Stripe Webhook Setup

Run Stripe listener locally:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the generated webhook secret into:

```env
STRIPE_WEBHOOK_SECRET=
```

---

## Deployment

### Frontend
- Vercel

### Backend / Database
- Convex

---

## Challenges Solved

- Real-time ticket synchronization
- Preventing overselling during concurrent purchases
- Waiting list queue handling
- Secure webhook verification
- Server/client component separation in Next.js
- Rate limiting event joins

---

## Future Improvements

- Email notifications
- Seat selection
- Refund automation
- Event analytics dashboard
- Multi-organizer support
- Admin moderation panel

---

## License

MIT