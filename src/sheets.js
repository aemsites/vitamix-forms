/**
 * Update sheet
 * @param {Context} ctx
 * @param {string} path 
 * @param {Sheet} json 
 * @returns {Promise<void>}
 */
export async function updateSheet(ctx, path, json) {
  const body = new FormData();
  const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
  body.append('data', blob);
  const resp = await fetch(`https://admin.da.live/source/${ctx.env.ORG}/${ctx.env.SITE}${path}`, {
    method: 'PUT',
    body,
    headers: {
      'Authorization': `Bearer ${process.env.DA_TOKEN}`
    }
  });
  if (!resp.ok) {
    console.error('failed to write sheet: ', resp.status, resp.headers.get('x-error'));
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
  const resp = await fetch(`https://admin.da.live/source/${ctx.env.ORG}/${ctx.env.SITE}${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${process.env.DA_TOKEN}`
    }
  });
  if (!resp.ok) {
    console.error('failed to fetch sheet: ', resp.status, resp.headers.get('x-error'));
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
  const resp = await fetch(`https://admin.da.live/list/${ctx.env.ORG}/${ctx.env.SITE}${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${process.env.DA_TOKEN}`
    }
  });
  if (!resp.ok) {
    console.error('failed to fetch folder: ', resp.status, resp.headers.get('x-error'));
    throw Error('failed to fetch folder');
  }
  return resp.json();
}