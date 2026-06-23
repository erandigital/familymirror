function normPhone(p) {
  return (p || "").replace(/[^0-9]/g, "");
}
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}
function chatLimitForPlan(plan) {
  if (plan === "gold") return 25;
  if (plan === "premium") return 10;
  return 0;
}

export async function onRequestPost(context) {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const body = await context.request.json();
    const phone = normPhone(body.phone);
    const message = (body.message || "").slice(0, 500);
    if (!phone || !message) {
      return new Response(JSON.stringify({ error: "missing phone or message" }), { status: 400, headers });
    }

    const key = "user_" + phone;
    const existing = await context.env.LEADS.get(key);
    if (!existing) {
      return new Response(JSON.stringify({ error: "profile_not_found" }), { status: 404, headers });
    }
    let record = JSON.parse(existing);

    const limit = chatLimitForPlan(record.plan);
    if (!record.paid || limit === 0) {
      return new Response(JSON.stringify({ error: "not_eligible" }), { status: 403, headers });
    }

    const m = currentMonth();
    if (!record.chatUsage || record.chatUsage.month !== m) record.chatUsage = { month: m, count: 0 };
    if (record.chatUsage.count >= limit) {
      return new Response(JSON.stringify({ error: "quota_exceeded", limit }), { status: 429, headers });
    }

    const lastReport = record.reports && record.reports[0] ? record.reports[0].result : null;
    const contextText = lastReport
      ? `נתוני הדוח האחרון של המשתמש (JSON): ${JSON.stringify(lastReport)}`
      : "אין עדיין דוח שמור עבור המשתמש הזה.";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": context.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `אתה עוזר AI ידידותי בתוך אפליקציית FamilyMirror, שעוזר להורים להבין את דוח דמיון הפנים של הילד/ה שלהם בצורה קלילה ומשעשעת.\n\n${contextText}\n\nשאלת המשתמש: ${message}\n\nהנחיות: ענה בעברית, בקצרה (2-4 משפטים), בטון חם וקליל. הבהר במידת הצורך שזה לבידור ולא ייעוץ גנטי או רפואי מקצועי. אל תמציא נתונים שלא קיימים בדוח.`
          }
        ]
      })
    });
    const aiData = await aiRes.json();
    const answer = (aiData.content || []).map((b) => b.text || "").join("").trim();

    record.chatUsage.count += 1;
    await context.env.LEADS.put(key, JSON.stringify(record));

    return new Response(
      JSON.stringify({ ok: true, answer, remaining: limit - record.chatUsage.count }),
      { headers }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
