import assert from 'node:assert/strict';
import test from 'node:test';
import {legacyArchiveId} from '../../ensaia_cloud/lib/legacy-report.ts';
import {passwordHash} from '../../ensaia_cloud/lib/security.ts';
import {startCloudSandbox} from './cloud-sandbox.mjs';

test('el informe histórico exige sesión de admin y agrega únicamente las parejas completas', async () => {
  const sandbox = await startCloudSandbox({deviceId:'worker-qa', secret:'synthetic-secret-only-for-testing'});
  const {origin, seedJSON} = sandbox;
  const username = 'ensaia_legacy', password = 'synthetic-admin-login';
  const adminDevice = 'archive-' + legacyArchiveId.slice(0, 24);
  const api = (action, options) => fetch(`${origin}/api/server?action=${action}`, options);
  async function seedAccount(name, deviceId) {
    seedJSON(`accounts/${name}.json`, {
      username:name, deviceId, createdAt:'2026-01-01T00:00:00Z', passwordHash:await passwordHash(password),
    });
  }
  async function login(name) {
    const result = await api('login', {
      method:'POST', headers:{origin,'content-type':'application/json'}, body:JSON.stringify({username:name,password}),
    });
    assert.equal(result.status,200);
    return {headers:{cookie:result.headers.get('set-cookie').split(';')[0]}};
  }
  const schema = 'ensaia-iot-import/v1';
  const take = (id, phase, fillers) => ({
    session_id:id, participant_code_original:'D001', participant_group_id:'L001',
    phase, started_at:'2026-01-01T00:00:00Z', status:'ended', feedback_enabled:true,
    transcript:{automatic_raw:'Texto de prueba',automatic_word_count:100,human_corrected:null},
    metrics_automatic:{audio_seconds:40,words_per_minute:150,filled_pause_candidates:fillers,
      contextual_filler_candidates:0,repetition_candidates:1,estimated_silences:[{}]},
    integrity:{technical_pair_candidate:true,relay_missing_frames:0,provider_finalization_confirmed:true},
    occurrences:[],source_events:[],human_evaluations:[],
  });
  try {
    await seedAccount('normal_user','normal-device');
    await seedAccount(username,adminDevice);
    assert.equal((await api('legacy-report')).status,401);
    const normal = await login('normal_user'), admin = await login(username);
    assert.equal((await api('legacy-report',normal)).status,403);
    assert.equal((await (await api('state',normal)).json()).legacyAdmin,false);
    assert.equal((await (await api('state',admin)).json()).legacyAdmin,true);

    const prefix = `legacy/${username}/${legacyArchiveId}`;
    const pre = take('00000001','pre',3), post = take('00000002','post',0);
    const incomplete = take('00000003','post',9);
    incomplete.integrity.technical_pair_candidate = false;
    incomplete.metrics_automatic.audio_seconds = null;
    seedJSON(prefix+'/manifest.json', {
      schema, files:[{role:'original'},{role:'relay'}], technical_pair_inventory:[{
        participant_code_original:'D001',participant_group_id:'L001',
        technically_complete_candidate_pairs:[{pre_session_id:pre.session_id,post_session_id:post.session_id}],
      }],
    });
    seedJSON(prefix+'/sessions.json', {schema,sessions:[pre,post,incomplete]});
    seedJSON(prefix+'/index.json', {sessions:[pre,post,incomplete].map(session => ({
      originalId:session.session_id,id:'00000000'+session.session_id,
    }))});

    const result = await api('legacy-report',admin);
    assert.equal(result.status,200);
    assert.equal(result.headers.get('cache-control'),'no-store');
    const report = await result.json();
    assert.equal(report.inventory.sessions,3);
    assert.equal(report.inventory.wav,2);
    assert.equal(report.comparison.pre.fillers,3);
    assert.equal(report.comparison.pre.fillersPerMinute,4.5);
    assert.equal(report.comparison.post.count,1);
    assert.equal(report.comparison.post.fillers,0);
    assert.equal(report.sessions.find(row=>row.originalId===incomplete.session_id).seconds,null);
    assert.equal((await api('legacy-report',normal)).status,403);
  } finally {
    await sandbox.close();
  }
});
