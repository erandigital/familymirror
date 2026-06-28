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
  try {
    if (!context.env.LEADS) {
      console.error("STRIPE WEBHOOK FATAL: LEADS KV binding is missing from this environment.");
      return new Response(JSON.stringify({ error: "KV binding LEADS not configured" }), { status: 500 });
    }
    if (!context.env.STRIPE_WEBHOOK_SECRET) {
      console.error("STRIPE WEBHOOK FATAL: STRIPE_WEBHOOK_SECRET is missing from this environment.");
      return new Response(JSON.stringify({ error: "STRIPE_WEBHOOK_SECRET not configured" }), { status: 500 });
    }

    const rawBody = await context.request.text();
    const sig = context.request.headers.get("Stripe-Signature");
    const secret = context.env.STRIPE_WEBHOOK_SECRET;

    const valid = await verifyStripeSignature(rawBody, sig, secret);
    if (!valid) {
      console.error("STRIPE WEBHOOK: signature verification failed.");
      return new Response("Invalid signature", { status: 400 });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      console.error("STRIPE WEBHOOK: failed to parse event JSON.", e.message);
      return new Response("Bad payload", { status: 400 });
    }

    console.log("STRIPE WEBHOOK received event:", event.type, event.id);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const phone = normPhone(session.client_reference_id);
      const amount = session.amount_total;
      const plan = mapAmountToPlan(amount);

      console.log("checkout.session.completed - phone:", phone || "(EMPTY - client_reference_id missing!)", "| amount:", amount, "| plan:", plan);

      if (phone) {
        const key = "user_" + phone;
        let record = {};
        const existing = await context.env.LEADS.get(key);
        if (existing) {
          try { record = JSON.parse(existing); } catch (e) { console.error("Corrupt existing record for", key, e.message); record = {}; }
        }

        record.paid = true;
        record.plan = plan;
        record.phone = phone;
        if (!record.name) record.name = "";
        if (!record.reports) record.reports = [];
        if (!record.usage) record.usage = { month: new Date().toISOString().slice(0, 7), count: 0 };
        if (session.mode === "subscription" && session.subscription) {
          record.subscriptionId = session.subscription;
          await context.env.LEADS.put("sub_" + session.subscription, phone);
        }

        await context.env.LEADS.put(key, JSON.stringify(record));
        console.log("STRIPE WEBHOOK: successfully marked", key, "as paid, plan =", plan);
      } else {
        console.error("STRIPE WEBHOOK: no client_reference_id on this session - cannot identify which customer paid. Check that 'URL parameters' (Client reference ID) is enabled on this Stripe Payment Link.");
      }
    }

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
  } catch (err) {
    console.error("STRIPE WEBHOOK UNCAUGHT ERROR:", err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
