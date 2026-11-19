// CapturedSource para los articulos de X ya descargados en disco.
// La identidad es el status de X; el slug solo dice donde esta la carpeta hoy.

export function createXArticleSource({ loadArticles }) {
  return {
    async listCaptured() {
      const seen = new Set();
      const captured = [];
      for (const article of await loadArticles()) {
        const key = xArticleKey(article);
        if (seen.has(key)) continue;
        seen.add(key);
        captured.push({
          key,
          kind: "article",
          title: article.title,
          authors: [article.author_name || article.author_handle].filter(Boolean),
          ref: { type: "x-article", slug: article.slug, status_url: article.status_url ?? null },
        });
      }
      return captured;
    },
  };
}

export function xArticleKey(article) {
  return article.status_id ? `x:status:${article.status_id}` : `x:slug:${article.slug}`;
}
