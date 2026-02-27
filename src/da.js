/**
 * Update sheet
 * @param {Context} ctx
 * @param {string} path 
 * @param {Sheet} json 
 * @returns {Promise<void>}
 */
export async function updateSheet(ctx, path, json) {
  const url = `https://admin.da.live/source/${ctx.env.ORG}/${ctx.env.SITE}${path}`;
  ctx.log.info(`updating sheet: ${url}`);
  const body = new FormData();
  const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
  body.append('data', blob);
  const resp = await fetch(url, {
    method: 'PUT',
    body,
    headers: {
      'Authorization': `Bearer ${ctx.events.token}`
    }
  });
  if (!resp.ok) {
    ctx.log.error('failed to write sheet: ', resp.status, resp.headers.get('x-error'));
    throw Error('failed to write sheet');
  }
  return;
}

/**
 * Fetch sheet
 * @param {Context} ctx
 * @param {string} path 
 * @returns {Promise<Sheet>}
 */
export async function fetchSheet(ctx, path) {
  const url = `https://admin.da.live/source/${ctx.env.ORG}/${ctx.env.SITE}${path}`;
  ctx.log.info(`fetching sheet: ${url}`);
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${ctx.events.token}`
    }
  });
  if (!resp.ok) {
    ctx.log.error('failed to fetch sheet: ', resp.status, resp.headers.get('x-error'));
    throw Error('failed to fetch sheet');
  }
  return resp.json();
}

/**
 * List folder contents
 * @param {Context} ctx
 * @param {string} path
 * @returns {Promise<FolderList>}
 */
export async function listFolder(ctx, path) {
  const url = `https://admin.da.live/list/${ctx.env.ORG}/${ctx.env.SITE}${path}`;
  ctx.log.info(`fetching folder: ${url}`);
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${ctx.events.token}`
    }
  });
  if (!resp.ok) {
    ctx.log.error('failed to fetch folder: ', resp.status, resp.headers.get('x-error'));
    throw Error('failed to fetch folder');
  }
  return resp.json();
}

/**
 * Fetch HTML from DA file
 * @param {Context} ctx 
 * @param {string} path 
 * @returns {Promise<string>}
 */
export async function fetchHTML(ctx, path) {
  const url = `https://admin.da.live/source/${ctx.env.ORG}/${ctx.env.SITE}${path.endsWith('.html') ? path : `${path}.html`}`;
  ctx.log.info(`fetching HTML: ${url}`);
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${ctx.events.token}`
    }
  });
  if (!resp.ok) {
    if (resp.status === 404) {
      return null;
    }
    ctx.log.error('failed to fetch HTML: ', resp.status, resp.headers.get('x-error'));
    throw Error('failed to fetch HTML');
  }
  return resp.text();
}