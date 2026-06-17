function normPhone(p) {
  return (p || "").replace(/[^0-9]/g, "");
}

export async function onRequestPost(context) {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const body = await context.request.json();
    const phone = normPhone(body.phone);
    if (!phone) return new Response(JSON.stringify({ error: "missing phone" }), { status: 400, headers });
    const key = "user_" + phone;

    let record = {};
    const existing = await context.env.LEADS.get(key);
    if (existing) record = JSON.parse(existing);

    if (body.action === "upsert") {
      record.name = body.name || record.name || "";
      record.phone = phone;
      if (!record.createdAt) record.createdAt = Date.now();
      if (record.paid === undefined) record.paid = false;
      if (!record.reports) record.reports = [];
    } else if (body.action === "setPaid") {
      record.paid = true;
      record.plan = body.plan || record.plan || "one_time";
    } else if (body.action === "addReport") {
      if (!record.reports) record.reports = [];
      record.reports.unshift({
        date: Date.now(),
        result: body.report || {}
      });
      record.reports = record.reports.slice(0, 20);
    }

    await context.env.LEADS.put(key, JSON.stringify(record));
    return new Response(JSON.stringify({ ok: true, record }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestGet(context) {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const url = new URL(context.request.url);
    const phone = normPhone(url.searchParams.get("phone"));
    if (!phone) return new Response(JSON.stringify({ found: false }), { headers });
    const existing = await context.env.LEADS.get("user_" + phone);
    if (!existing) return new Response(JSON.stringify({ found: false }), { headers });
    return new Response(JSON.stringify({ found: true, record: JSON.parse(existing) }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
