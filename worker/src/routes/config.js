import { jsonResponse } from '../http.js';
import { issueChallenge } from '../auth.js';

export async function handleGetConfig(request, env) {
  const minPluginVersion = env.MIN_PLUGIN_VERSION || '0.1.0';
  const writesEnabled = env.WRITES_ENABLED !== 'false';
  const inviteRequired = env.INVITE_REQUIRED !== 'false';
  const systemNotice = env.SYSTEM_NOTICE || '';

  return jsonResponse({
    apiVersion: 1,
    minPluginVersion,
    writesEnabled,
    inviteRequired,
    systemNotice,
    limits: {
      quoteMaxChars: 200,
      selectionMaxChars: 500,
      bodyMinChars: 10,
      bodyMaxChars: 2000,
      contextChars: 30,
      dailyVotesMax: 60,
    },
    license: 'CC BY-SA 4.0',
  });
}

export async function handleGetChallenge(request, env) {
  const difficulty = Number(env.POW_DIFFICULTY || 14);
  const challenge = await issueChallenge(env, difficulty);
  return jsonResponse(challenge, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
