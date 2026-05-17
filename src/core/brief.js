export function buildSocialBrief(document, mode) {
  if (!document.signals || mode === "none") {
    return null;
  }

  const signals = document.signals;
  const metrics = signals.metrics ?? {};
  const awareness = signals.awareness ?? {};
  const lines = [];

  lines.push(`# Brief: ${document.article.title}`);
  lines.push("");
  lines.push(`Fuente: ${document.source.status_url}`);
  lines.push("");
  lines.push(`Estado viral: ${awareness.viral_stage ?? "unknown"}`);
  lines.push(`Velocidad: ${awareness.engagement_velocity_bucket ?? "unknown"}`);
  lines.push(`Sentimiento: ${awareness.sentiment_mix ?? "unknown"}`);

  if (metrics.likes != null || metrics.replies != null || metrics.quotes != null) {
    lines.push("");
    lines.push("## Metricas");
    lines.push("");
    lines.push(`- Likes: ${metrics.likes ?? "n/a"}`);
    lines.push(`- Replies: ${metrics.replies ?? "n/a"}`);
    lines.push(`- Reposts: ${metrics.reposts ?? "n/a"}`);
    lines.push(`- Quotes: ${metrics.quotes ?? "n/a"}`);
    lines.push(`- Impressions: ${metrics.impressions ?? "n/a"}`);
    lines.push(`- Bookmarks: ${metrics.bookmarks ?? "n/a"}`);
  }

  lines.push("");
  lines.push("## Lectura Rapida");
  lines.push("");
  lines.push(`- ${awareness.summary ?? "No hubo suficiente contexto para sintetizar awareness adicional."}`);

  if ((signals.conversation?.recurring_themes ?? []).length > 0) {
    lines.push(`- Temas en replies: ${signals.conversation.recurring_themes.map((item) => item.theme).join(", ")}`);
  }

  if ((signals.quotes?.recurring_themes ?? []).length > 0) {
    lines.push(`- Temas en quotes: ${signals.quotes.recurring_themes.map((item) => item.theme).join(", ")}`);
  }

  if ((awareness.skepticism_themes ?? []).length > 0) {
    lines.push(`- Objeciones: ${awareness.skepticism_themes.join(", ")}`);
  }

  if ((awareness.implementation_interest_themes ?? []).length > 0) {
    lines.push(`- Interes de implementacion: ${awareness.implementation_interest_themes.join(", ")}`);
  }

  if (mode === "full" && (awareness.notable_amplifiers ?? []).length > 0) {
    lines.push("");
    lines.push("## Amplificadores");
    lines.push("");
    for (const amplifier of awareness.notable_amplifiers) {
      lines.push(`- ${amplifier.handle ?? amplifier.name ?? "unknown"}: ${amplifier.reason ?? "mencionado por el provider"}`);
    }
  }

  return {
    mode,
    generated_at: new Date().toISOString(),
    markdown: `${lines.join("\n").trim()}\n`,
    summary: awareness.summary ?? null,
    highlights: [
      awareness.viral_stage && `viral_stage=${awareness.viral_stage}`,
      awareness.engagement_velocity_bucket && `engagement_velocity=${awareness.engagement_velocity_bucket}`,
      awareness.sentiment_mix && `sentiment=${awareness.sentiment_mix}`,
    ].filter(Boolean),
  };
}
