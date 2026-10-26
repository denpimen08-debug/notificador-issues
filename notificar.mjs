// sis-inf-bot · Solo lectura. Revisa los comentarios nuevos de los repos de sis-inf y avisa por Gmail
// cuando alguien PIDE un issue, con su conteo X/10 ya calculado. Nunca comenta, asigna ni modifica nada.
//
// Un comentario cuenta como solicitud si:
//   1. está en un issue ABIERTO (no PR) de uno de los repos,
//   2. el issue NO tiene a nadie asignado,
//   3. quien comenta NO es el autor del issue,
//   4. es el PRIMER comentario de ese tipo en el issue (si llega otro, el correo avisa que ya había una solicitud previa).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const API = process.env.API_BASE || 'https://api.github.com';
const OWNER = process.env.OWNER || 'sis-inf';
const REPOS = (process.env.REPOS || 'ChuspaSocial,ChuspaPulse,sis-inf,ChuspaCalc,ChuspaNumeric,ChuspaDB')
  .split(',').map(s => s.trim()).filter(Boolean);
const YO = (process.env.MI_USUARIO || '').toLowerCase();       // tus propios comentarios no te avisan
const HORAS = Number(process.env.VENTANA_HORAS || 3);          // cuánto hacia atrás mira en cada ejecución
const LIMITE = Number(process.env.LIMITE || 10);               // máximo de issues por usuario
const DRY = process.env.DRY_RUN === '1';                       // vista previa: guarda el HTML en vez de enviar
const TO = process.env.MAIL_TO || process.env.GMAIL_USER;      // admite varios separados por coma
const ES_COLABORADOR = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function gh(url) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} en ${url}`);
  return r.json();
}
async function ghAll(path, maxPages = 5) {
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const chunk = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
    out.push(...chunk);
    if (chunk.length < 100) break;
  }
  return out;
}

const cacheComentarios = new Map();
const comentariosDe = async issue => {
  if (!cacheComentarios.has(issue.comments_url)) cacheComentarios.set(issue.comments_url, await ghAll(issue.comments_url));
  return cacheComentarios.get(issue.comments_url);
};
// Primer comentario de alguien que no es el autor del issue ni un bot = la solicitud ganadora
const primeraSolicitud = async issue =>
  (await comentariosDe(issue)).find(c => c.user && c.user.type !== 'Bot' && c.user.login !== issue.user.login);

function correoHtml(d) {
  const cuerpo = esc(d.comentario.body.length > 1500 ? d.comentario.body.slice(0, 1500) + '…' : d.comentario.body).replace(/\r?\n/g, '<br>');
  const fila = (k, v) => `<p style="margin:0 0 14px;font-size:16px;color:#57606a">${k}: <span style="color:#1f2328">${v}</span></p>`;
  const color = d.veredicto.tipo === 'ok' ? '#1a7f37' : d.veredicto.tipo === 'no' ? '#cf222e' : '#9a6700';
  const notas = d.notas.map(n => `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#57606a">• ${n}</p>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:24px 12px;background:#f6f8fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d0d7de;border-radius:12px">
<tr><td style="padding:28px 28px 8px">
  <p style="margin:0 0 16px;font-size:15px;color:#57606a">Notificación de nuevo comentario</p>
  <h1 style="margin:0 0 22px;font-size:22px;color:#1f2328">Nuevo comentario en un Issue</h1>
  ${fila('Repositorio', `<code style="background:#eaeef2;border-radius:6px;padding:3px 8px;font-size:14px;font-family:ui-monospace,Consolas,monospace">${esc(OWNER)}/${esc(d.repo)}</code>`)}
  ${fila('Número de Issue', `<a href="${esc(d.issue.html_url)}" style="color:#0969da;text-decoration:none">#${d.issue.number}</a>`)}
  ${fila('Título', esc(d.issue.title))}
  ${fila('Comentado por', `${esc(d.usuario)} <span style="color:#57606a">(colaborador: ${d.colaborador ? 'sí' : 'no'})</span>`)}
  ${fila('Conteo', `<b>${d.total}/${LIMITE}</b> <span style="color:#57606a">(${d.asignados} asignado${d.asignados === 1 ? '' : 's'} + ${d.solicitados} solicitado${d.solicitados === 1 ? '' : 's'})</span>`)}
  ${fila('Veredicto', `<b style="color:${color}">${esc(d.veredicto.texto)}</b>`)}
  ${notas}
</td></tr>
<tr><td style="padding:0 28px"><hr style="border:0;border-top:1px solid #d0d7de;margin:10px 0 20px"></td></tr>
<tr><td style="padding:0 28px 8px">
  <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#1f2328">Comentario:</p>
  <p style="margin:0;font-size:16px;line-height:1.55;color:#1f2328">${cuerpo}</p>
</td></tr>
<tr><td align="center" style="padding:26px 28px 32px">
  <a href="${esc(d.comentario.html_url)}" style="display:inline-block;background:#1f2328;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">↗ Ver comentario en GitHub</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

async function main() {
  let estado = { vistos: {} };
  try { estado = JSON.parse(await readFile('estado.json', 'utf8')); } catch {}
  estado.vistos ||= {};
  const ahora = Date.now();
  const desde = new Date(ahora - HORAS * 3600e3).toISOString();
  const repoQ = REPOS.map(r => `repo:${OWNER}/${r}`).join(' ');
  const cacheIssues = new Map();
  let enviados = 0, fallos = 0, cambios = false;

  let transporte = null;
  if (!DRY) {
    const { default: nodemailer } = await import('nodemailer');
    transporte = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  } else await mkdir('salida', { recursive: true });

  for (const repo of REPOS) {
    let comentarios;
    try { comentarios = await ghAll(`/repos/${OWNER}/${repo}/issues/comments?since=${desde}&sort=created&direction=asc`); }
    catch (e) { console.error(`${repo}: ${e.message}`); fallos++; continue; }

    for (const c of comentarios) {
      if (estado.vistos[c.id]) continue;
      if (new Date(c.created_at) < new Date(desde)) continue;       // comentario viejo que solo fue editado
      const marcar = () => { estado.vistos[c.id] = ahora; cambios = true; };
      try {
        const usuario = c.user?.login;
        if (!usuario || c.user.type === 'Bot' || usuario.toLowerCase() === YO) { marcar(); continue; }

        let issue = cacheIssues.get(c.issue_url);
        if (!issue) { issue = await gh(c.issue_url); cacheIssues.set(c.issue_url, issue); }
        if (issue.pull_request || issue.state !== 'open') { marcar(); continue; }       // regla 1
        if ((issue.assignees || []).length) { marcar(); continue; }                     // regla 2
        if (usuario === issue.user.login) { marcar(); continue; }                       // regla 3

        const primera = await primeraSolicitud(issue);                                  // regla 4
        const esPrimera = primera?.id === c.id;
        if (!esPrimera && primera?.user.login === usuario) { marcar(); continue; }     // el mismo usuario insistiendo

        // ---- conteo X/10 ----
        const asignados = (await gh(`/search/issues?per_page=1&q=${encodeURIComponent(`${repoQ} is:issue is:open assignee:${usuario}`)}`)).total_count;
        const busqueda = await gh(`/search/issues?per_page=100&q=${encodeURIComponent(`${repoQ} is:issue is:open no:assignee commenter:${usuario}`)}`);
        let solicitados = 0, incluyeActual = false;
        for (const it of busqueda.items) {
          if (it.user?.login === usuario) continue;                                      // su propio issue no es «solicitud»
          const esActual = it.number === issue.number && it.repository_url.endsWith('/' + repo);
          const p = esActual ? primera : await primeraSolicitud(it);
          if (p?.user.login === usuario) { solicitados++; if (esActual) incluyeActual = true; }
        }
        if (esPrimera && !incluyeActual) solicitados++;                                  // la búsqueda puede tardar en indexar el comentario nuevo
        const total = asignados + solicitados;

        const colaborador = ES_COLABORADOR.has(c.author_association);
        const notas = [];
        let veredicto;
        if (!esPrimera) {
          veredicto = { tipo: 'aviso', texto: `ya hay una solicitud previa de ${primera.user.login}` };
          notas.push(`El issue es de quien comentó primero (<a href="${esc(primera.html_url)}">${esc(primera.user.login)}</a>). Este comentario no cambia su conteo.`);
        } else if (total > LIMITE) {
          veredicto = { tipo: 'no', texto: 'supera el límite, no asignar' };
        } else {
          // Máximo 10 = puede tener hasta 10 (esta solicitud incluida). Solo cuentan issues, no PRs abiertos.
          veredicto = { tipo: 'ok', texto: total === LIMITE ? 'puede asignarse (quedará en 10/10)' : 'puede asignarse' };
        }
        if (colaborador) notas.push('Es colaborador: no puede asignarse a sí mismo, otro colaborador debe hacerlo.');

        const datos = { repo, issue, comentario: c, usuario, colaborador, asignados, solicitados, total, veredicto, notas };
        const asunto = `[sis-inf-bot] Nuevo comentario en #${issue.number} — ${issue.title} · ${usuario} ${total}/${LIMITE}`;
        const html = correoHtml(datos);
        if (DRY) { await writeFile(`salida/correo-${c.id}.html`, html); console.log('ASUNTO:', asunto, '|', veredicto.texto); }
        else await transporte.sendMail({ from: `sis-inf-bot <${process.env.GMAIL_USER}>`, to: TO, subject: asunto, html });
        enviados++; marcar();
      } catch (e) { console.error(`Comentario ${c.id}: ${e.message}`); fallos++; }       // se reintenta en la próxima ejecución
    }
  }

  for (const [id, t] of Object.entries(estado.vistos)) if (ahora - t > 3 * 864e5) { delete estado.vistos[id]; cambios = true; }
  // Latido: un commit al mes mantiene activo el repo (GitHub pausa las tareas programadas tras 60 días sin actividad)
  if (!estado.latido || ahora - new Date(estado.latido) > 20 * 864e5) { estado.latido = new Date(ahora).toISOString(); cambios = true; }
  if (cambios) await writeFile('estado.json', JSON.stringify(estado, null, 2) + '\n');
  console.log(`Correos enviados: ${enviados}${fallos ? ` · errores: ${fallos}` : ''}`);
  if (fallos) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
