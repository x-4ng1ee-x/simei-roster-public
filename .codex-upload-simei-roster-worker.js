const CONFIG = {
  privateRepo: 'x-4ng1ee-x/simei-roster-private',
  publicRepo: 'x-4ng1ee-x/simei-roster-public',
  privatePath: 'cast-master.json',
  publicPath: 'roster.json',
  branch: 'main',
  pagesUrl: 'https://x-4ng1ee-x.github.io/simei-roster-public/roster.json',
  maxCasts: 24
};

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Roster-Api-Key'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: jsonHeaders });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(200, { ok: true, service: 'simei-roster-worker' });
    }

    if (!url.pathname.startsWith('/api/')) {
      return json(404, { ok: false, error: 'Not found' });
    }

    if (!(await isAuthorized(request, env))) {
      return json(401, { ok: false, error: 'Unauthorized' });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return json(200, {
          ok: true,
          config: {
            privateRepo: CONFIG.privateRepo,
            publicRepo: CONFIG.publicRepo,
            privatePath: CONFIG.privatePath,
            publicPath: CONFIG.publicPath,
            branch: CONFIG.branch,
            pagesUrl: CONFIG.pagesUrl,
            maxCasts: CONFIG.maxCasts
          }
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/master') {
        const remote = await getJsonFile(env, CONFIG.privateRepo, CONFIG.privatePath);
        return json(200, {
          ok: true,
          master: remote.value || defaultMaster(),
          sha: remote.sha
        });
      }

      if (request.method === 'PUT' && url.pathname === '/api/master') {
        const body = await readJsonBody(request);
        const validation = validateMaster(body.master);

        if (!validation.ok) {
          return json(422, validation);
        }

        const remote = await getJsonFile(env, CONFIG.privateRepo, CONFIG.privatePath);
        if (body.sha && remote.sha && body.sha !== remote.sha) {
          return json(409, {
            ok: false,
            error: '他の運営者が先に名簿を更新しています。',
            latestSha: remote.sha,
            latestMaster: remote.value || defaultMaster()
          });
        }

        const master = {
          ...validation.master,
          updatedAt: nowJstIso()
        };
        const result = await putJsonFile(env, CONFIG.privateRepo, CONFIG.privatePath, master, remote.sha, 'Update cast master');

        return json(200, {
          ok: true,
          master,
          sha: result.content?.sha || null
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/preview') {
        const body = await readJsonBody(request);
        const masterRemote = await getJsonFile(env, CONFIG.privateRepo, CONFIG.privatePath);
        const rosterRemote = await getJsonFile(env, CONFIG.publicRepo, CONFIG.publicPath);
        const result = buildRoster({
          master: masterRemote.value || defaultMaster(),
          selectedNames: body.selectedNames || [],
          businessDate: body.businessDate,
          maxCasts: CONFIG.maxCasts,
          existingRoster: rosterRemote.value
        });

        return json(result.ok ? 200 : 422, result);
      }

      if (request.method === 'POST' && url.pathname === '/api/publish') {
        const body = await readJsonBody(request);
        const masterRemote = await getJsonFile(env, CONFIG.privateRepo, CONFIG.privatePath);
        const rosterRemote = await getJsonFile(env, CONFIG.publicRepo, CONFIG.publicPath);
        const result = buildRoster({
          master: masterRemote.value || defaultMaster(),
          selectedNames: body.selectedNames || [],
          businessDate: body.businessDate,
          maxCasts: CONFIG.maxCasts,
          existingRoster: rosterRemote.value
        });

        if (!result.ok) {
          return json(422, result);
        }

        await putJsonFile(
          env,
          CONFIG.publicRepo,
          CONFIG.publicPath,
          result.roster,
          rosterRemote.sha,
          `Update roster ${result.roster.businessDate} v${result.roster.shiftVersion}`
        );

        const pages = await waitForPages(result.roster);

        return json(200, {
          ok: true,
          roster: result.roster,
          warnings: result.warnings,
          pages
        });
      }

      return json(404, { ok: false, error: 'API not found' });
    } catch (error) {
      return json(500, { ok: false, error: sanitizeError(error) });
    }
  }
};

async function isAuthorized(request, env) {
  const provided =
    request.headers.get('x-roster-api-key') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = env.APP_API_KEY || '';

  if (!provided || !expected) return false;
  return constantTimeEqual(provided, expected);
}

async function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b))
  ]);
  const aBytes = new Uint8Array(aHash);
  const bBytes = new Uint8Array(bHash);
  let diff = a.length === b.length ? 0 : 1;

  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }

  return diff === 0;
}

async function getJsonFile(env, repo, filePath) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(CONFIG.branch)}`;
  const response = await githubFetch(env, url, { method: 'GET' });

  if (response.status === 404) {
    return { value: null, sha: null };
  }

  if (!response.ok) {
    throw new Error(`GitHub file fetch failed: ${response.status}`);
  }

  const data = await response.json();
  const text = decodeBase64(data.content || '');
  return {
    value: JSON.parse(text),
    sha: data.sha
  };
}

async function putJsonFile(env, repo, filePath, value, sha, message) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}`;
  const body = {
    message,
    branch: CONFIG.branch,
    content: encodeBase64(`${JSON.stringify(value, null, 2)}\n`)
  };

  if (sha) body.sha = sha;

  const response = await githubFetch(env, url, {
    method: 'PUT',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    if (response.status === 409) {
      throw new Error('GitHub update conflict');
    }
    throw new Error(`GitHub file update failed: ${response.status}`);
  }

  return response.json();
}

function githubFetch(env, url, init) {
  return fetch(url, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'simei-roster-worker',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
}

function buildRoster({ master, selectedNames, businessDate, maxCasts, existingRoster }) {
  const validation = validateMaster(master);
  const errors = [...validation.errors];
  const warnings = [];
  const selected = Array.isArray(selectedNames) ? selectedNames.map(normalizeText).filter(Boolean) : [];
  const selectedSet = new Set(selected);
  const date = normalizeText(businessDate);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push('営業日はYYYY-MM-DD形式で指定してください。');
  }

  if (selected.length !== selectedSet.size) {
    errors.push('出勤選択が重複しています。');
  }

  if (selectedSet.size > maxCasts) {
    errors.push(`出勤予定者数が最大人数${maxCasts}を超えています。`);
  }

  if (selectedSet.size === 0) {
    warnings.push('出勤予定者が未選択です。');
  }

  const byName = new Map(validation.master.casts.map((cast) => [cast.name, cast]));
  const selectedCasts = [];

  for (const name of selectedSet) {
    const cast = byName.get(name);
    if (!cast) {
      errors.push(`${name}: 名簿に存在しません。`);
      continue;
    }
    if (!cast.active) {
      errors.push(`${name}: 無効化済みのため出勤予定に追加できません。`);
      continue;
    }
    selectedCasts.push(cast);
  }

  const now = nowJstIso();
  const roster = {
    schemaVersion: 1,
    businessDate: date,
    shiftVersion: nextShiftVersion(existingRoster),
    createdAt:
      existingRoster?.businessDate === date && existingRoster?.createdAt
        ? existingRoster.createdAt
        : now,
    updatedAt: now,
    casts: orderedRosterCasts(selectedCasts)
  };

  return {
    ok: errors.length === 0,
    errors: unique(errors),
    warnings,
    roster
  };
}

function validateMaster(master) {
  const errors = [];
  const raw = Array.isArray(master?.casts) ? master.casts : [];
  const casts = [];
  const names = new Set();

  for (let i = 0; i < raw.length; i++) {
    const cast = normalizeCast(raw[i]);
    const label = cast.name || `${i + 1}行目`;

    if (!cast.name) errors.push(`名簿の${i + 1}行目: 名前が空です。`);
    if (!cast.kana) errors.push(`${label}: 読み仮名が空です。`);
    if (!cast.gender) errors.push(`${label}: 性別はmaleまたはfemaleを指定してください。`);

    if (cast.name) {
      if (names.has(cast.name)) {
        errors.push(`${cast.name}: 同じ名前のキャストが名簿内に存在します。`);
      }
      names.add(cast.name);
    }

    casts.push(cast);
  }

  return {
    ok: errors.length === 0,
    errors: unique(errors),
    master: {
      schemaVersion: 1,
      updatedAt: master?.updatedAt || null,
      casts
    }
  };
}

function normalizeCast(input) {
  return {
    name: normalizeText(input?.name),
    kana: normalizeKana(input?.kana),
    gender: normalizeGender(input?.gender),
    active: input?.active !== false,
    createdAt: input?.createdAt || nowJstIso(),
    updatedAt: input?.updatedAt || nowJstIso()
  };
}

function orderedRosterCasts(casts) {
  const output = [];

  for (const gender of ['female', 'male']) {
    const sorted = casts.filter((cast) => cast.gender === gender).sort(compareCast);
    for (let i = 0; i < sorted.length; i++) {
      output.push({
        name: sorted[i].name,
        gender,
        order: i + 1
      });
    }
  }

  return output;
}

function compareCast(a, b) {
  const genderOrder = ['female', 'male'];
  const genderCompare = genderOrder.indexOf(a.gender) - genderOrder.indexOf(b.gender);
  if (genderCompare !== 0) return genderCompare;

  const kanaCompare = normalizeKana(a.kana).localeCompare(normalizeKana(b.kana), 'ja');
  if (kanaCompare !== 0) return kanaCompare;

  return normalizeText(a.name).localeCompare(normalizeText(b.name), 'ja');
}

async function waitForPages(expectedRoster) {
  const started = Date.now();
  let lastError = '';

  while (Date.now() - started < 60000) {
    try {
      const response = await fetch(CONFIG.pagesUrl, {
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (response.ok) {
        const roster = await response.json();
        if (
          roster.shiftVersion === expectedRoster.shiftVersion &&
          roster.businessDate === expectedRoster.businessDate &&
          roster.updatedAt === expectedRoster.updatedAt
        ) {
          return { ok: true, elapsedMs: Date.now() - started };
        }
        lastError = `Pages反映待ち: v${roster.shiftVersion || 'unknown'}`;
      } else {
        lastError = `Pages取得失敗: ${response.status}`;
      }
    } catch (error) {
      lastError = error.message;
    }

    await delay(3000);
  }

  return {
    ok: false,
    error: lastError || 'Pages反映確認がタイムアウトしました。',
    elapsedMs: Date.now() - started
  };
}

function defaultMaster() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    casts: []
  };
}

function nextShiftVersion(existingRoster) {
  const current = Number(existingRoster?.shiftVersion);
  return Number.isFinite(current) && current >= 0 ? Math.floor(current) + 1 : 1;
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeKana(value) {
  const text = normalizeText(value);
  let result = '';

  for (const char of text) {
    const code = char.charCodeAt(0);
    result += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : char;
  }

  return result;
}

function normalizeGender(value) {
  const gender = normalizeText(value).toLowerCase();
  return gender === 'male' || gender === 'female' ? gender : '';
}

function nowJstIso() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${jst.toISOString().slice(0, 19)}+09:00`;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(text) {
  const binary = atob(text.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function readJsonBody(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: jsonHeaders
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(items) {
  return [...new Set(items)];
}

function sanitizeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted-token]');
}
