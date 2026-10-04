export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) {
      if (secret) text = text.split(secret).join('[скрыто]');
    }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/token|secret|authorization|sign/i.test(key)) return [key, '[скрыто]'];
      return [key, redact(item, secrets)];
    }));
  }
  return value;
}

export function summarize(posts) {
  return {
    uniquePosts: posts.length,
    donutPosts: posts.filter(post => post.donut?.is_donut).length,
    placeholders: posts.filter(post => post.donut?.placeholder != null).length,
    postsWithText: posts.filter(post => Boolean(post.text)).length,
    postsWithAttachments: posts.filter(post => post.attachments?.length).length,
    attachments: posts.reduce((count, post) => count + (post.attachments?.length || 0), 0),
    postFields: [...new Set(posts.flatMap(post => Object.keys(post)))].sort(),
    donutFields: [...new Set(posts.flatMap(post => Object.keys(post.donut || {})))].sort(),
    sample: posts.slice(0, 10).map(post => ({
      id: post.id,
      owner_id: post.owner_id,
      textLength: (post.text || '').length,
      attachmentTypes: (post.attachments || []).map(item => item.type),
      donut: post.donut
    }))
  };
}

export async function fetchArchive(call, ownerId, limit, onPage, shouldStop) {
  const unique = new Map();
  let offset = 0;
  let received = 0;
  let total = null;
  let reason = 'limit';
  while (received < limit) {
    if (shouldStop()) {
      reason = 'stopped';
      break;
    }
    const count = Math.min(100, limit - received);
    const page = await call('wall.get', { owner_id: ownerId, filter: 'donut', count, offset });
    if (!Array.isArray(page?.items)) throw new Error('wall.get вернул ответ без массива items');
    total = page.count;
    for (const post of page.items) unique.set(`${post.owner_id}_${post.id}`, post);
    received += page.items.length;
    offset += page.items.length;
    onPage({ posts: [...unique.values()], total, received, offset });
    if (!page.items.length || (Number.isFinite(total) && offset >= total)) {
      reason = 'end';
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return { posts: [...unique.values()], total, received, duplicates: received - unique.size, reason };
}
