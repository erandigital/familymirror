function normPhone(p) {
  return (p || "").replace(/[^0-9]/g, "");
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=")));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expectedSig = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expectedSig === signature;
}

// Each plan has a distinct price, in agorot (smallest ILS unit) - 7.90 ₪ = 790
function mapAmountToPlan(amount) {
  if (amount === 790) return "one_time";
  if (amount === 990) return "basic";
  if (amount === 1990) return "premium";
  if (amount === 2990) return "gold";
  return "unknown";
}

export async function onRequestPost(context) {
  const rawBody = await context.request.text();
  const sig = context.request.headers.get("Stripe-Signature");
  const secret = context.env.STRIPE_WEBHOOK_SECRET;

  const valid = await verifyStripeSignature(rawBody, sig, secret);
  if (!valid) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response("Bad payload", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const phone = normPhone(session.client_reference_id);
    const amount = session.amount_total;
    const plan = mapAmountToPlan(amount);

    if (phone) {
      const key = "user_" + phone;
      let record = {};
      const existing = await context.env.LEADS.get(key);
      if (existing) record = JSON.parse(existing);

      record.paid = true;
      record.plan = plan;
      record.phone = phone;
      if (!record.name) record.name = "";
      if (!record.reports) record.reports = [];
      if (!record.usage) record.usage = { month: new Date().toISOString().slice(0, 7), count: 0 };
      if (session.mode === "subscription" && session.subscription) {
        record.subscriptionId = session.subscription;
        // reverse index so cancellation/payment-failure webhooks (which only carry
        // the subscription id, not the phone) can find this user's record later
        await context.env.LEADS.put("sub_" + session.subscription, phone);
      }

      await context.env.LEADS.put(key, JSON.stringify(record));
    }
  }

  // Subscription cancelled (immediately or at period end, depending on Stripe settings)
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const phone = await context.env.LEADS.get("sub_" + sub.id);
    if (phone) {
      const key = "user_" + phone;
      const existing = await context.env.LEADS.get(key);
      if (existing) {
        let record = JSON.parse(existing);
        record.paid = false;
        record.cancelledAt = Date.now();
        await context.env.LEADS.put(key, JSON.stringify(record));
      }
    }
  }

  // Recurring payment failed (card declined, expired, etc.) - revoke access until resolved
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    const subId = invoice.subscription;
    if (subId) {
      const phone = await context.env.LEADS.get("sub_" + subId);
      if (phone) {
        const key = "user_" + phone;
        const existing = await context.env.LEADS.get(key);
        if (existing) {
          let record = JSON.parse(existing);
          record.paid = false;
          record.paymentFailedAt = Date.now();
          await context.env.LEADS.put(key, JSON.stringify(record));
        }
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" }
  });
}
