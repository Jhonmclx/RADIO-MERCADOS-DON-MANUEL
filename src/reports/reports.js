// Reportes de publicidad basados exclusivamente en eventos registrados (nada se simula ni se infiere de más).
import { localToUtcMs, utcToLocalString } from '../lib/time.js';

const CONFIRM_RATIO = 0.9;

export function siteStatusFor(play, site, conf, connected) {
  const expected = play.first_seq != null && play.last_seq != null ? play.last_seq - play.first_seq + 1 : null;
  if (conf && conf.segments_seen > 0) {
    const ratio = expected ? conf.segments_seen / expected : 0;
    return {
      siteId: site.id, site: site.name,
      status: ratio >= CONFIRM_RATIO ? 'confirmada' : 'parcial',
      segmentsSeen: conf.segments_seen, segmentsExpected: expected,
      firstSeenAt: conf.first_seen_at, lastSeenAt: conf.last_seen_at,
    };
  }
  if (connected) return { siteId: site.id, site: site.name, status: 'conectada_sin_confirmacion', segmentsSeen: 0, segmentsExpected: expected };
  return { siteId: site.id, site: site.name, status: 'sin_conexion', segmentsSeen: 0, segmentsExpected: expected };
}

export class Reports {
  constructor({ db, cfg, engine }) { this.db = db; this.cfg = cfg; this.engine = engine; }

  _range(q) {
    const tz = this.cfg.timezone;
    const from = q.from ? localToUtcMs(`${q.from}T00:00`, tz) : null;
    const to = q.to ? localToUtcMs(`${q.to}T00:00`, tz) + 86_400_000 : null;
    return { from, to };
  }

  plays(q = {}) {
    const where = ["p.status NOT IN ('programado', 'descartado')"]; const args = [];
    if (q.includeAll) where.length = 0;
    const { from, to } = this._range(q);
    if (from != null) { where.push('COALESCE(p.started_at, p.scheduled_at) >= ?'); args.push(from); }
    if (to != null) { where.push('COALESCE(p.started_at, p.scheduled_at) < ?'); args.push(to); }
    if (q.adId) { where.push('p.ad_id = ?'); args.push(Number(q.adId)); }
    if (q.advertiserId) { where.push('p.advertiser_id = ?'); args.push(Number(q.advertiserId)); }
    if (q.status) {
      if (q.status === 'incierto') where.push("p.status = 'emitiendo'");
      else { where.push('p.status = ?'); args.push(String(q.status)); }
    }
    if (q.siteId) { where.push('EXISTS (SELECT 1 FROM site_ad_confirmations c WHERE c.ad_play_id = p.id AND c.site_id = ? AND c.segments_seen > 0)'); args.push(Number(q.siteId)); }
    const limit = Math.min(Number(q.limit) || 200, 5000);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const sql = `SELECT p.* FROM ad_plays p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(p.started_at, p.scheduled_at) DESC LIMIT ? OFFSET ?`;
    const rows = this.db.all(sql, ...args, limit, offset);
    const total = this.db.get(`SELECT COUNT(*) AS n FROM ad_plays p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...args).n;
    const sites = this.db.all('SELECT id, name FROM sites ORDER BY id');
    const currentPlayId = this.engine?.current?.adPlayId;
    return {
      total,
      items: rows.map((p) => {
        const confs = this.db.all('SELECT * FROM site_ad_confirmations WHERE ad_play_id = ?', p.id);
        const sc = p.sites_connected ? JSON.parse(p.sites_connected) : {};
        const connected = new Set([...(sc.alInicio || []), ...(sc.alFinal || [])]);
        let status = p.status;
        if (status === 'emitiendo' && p.id !== currentPlayId) status = 'incierto';
        return {
          id: p.id, adId: p.ad_id, adName: p.ad_name, advertiserId: p.advertiser_id, advertiserName: p.advertiser_name,
          status, interruptionReason: p.interruption_reason, scheduledAt: p.scheduled_at, startedAt: p.started_at, endedAt: p.ended_at,
          expectedMs: p.expected_ms, observedMs: p.observed_ms, configVersion: p.config_version, firstSeq: p.first_seq, lastSeq: p.last_seq,
          sitesConnectedAtStart: sc.alInicio || [], sitesConnectedAtEnd: sc.alFinal || [],
          sites: sites.map((s) => siteStatusFor(p, s, confs.find((c) => c.site_id === s.id), connected.has(s.id))),
        };
      }),
    };
  }

  summary(dateLocal) {
    const tz = this.cfg.timezone;
    const from = localToUtcMs(`${dateLocal}T00:00`, tz);
    const to = from + 86_400_000;
    const ads = this.db.all(`SELECT ad_id, ad_name, advertiser_name,
        SUM(CASE WHEN status = 'completado' THEN 1 ELSE 0 END) AS completados,
        SUM(CASE WHEN status = 'interrumpido' THEN 1 ELSE 0 END) AS interrumpidos,
        SUM(CASE WHEN status = 'fallido' THEN 1 ELSE 0 END) AS fallidos,
        SUM(COALESCE(observed_ms, 0)) AS ms_emitidos
      FROM ad_plays WHERE COALESCE(started_at, scheduled_at) >= ? AND COALESCE(started_at, scheduled_at) < ? AND status NOT IN ('programado','descartado')
      GROUP BY ad_id ORDER BY completados DESC`, from, to);
    const perSite = this.db.all(`SELECT c.site_id, s.name, p.ad_id, COUNT(*) AS emisiones_con_telemetria,
        SUM(CASE WHEN p.last_seq IS NOT NULL AND c.segments_seen >= ${CONFIRM_RATIO} * (p.last_seq - p.first_seq + 1) THEN 1 ELSE 0 END) AS confirmadas
      FROM site_ad_confirmations c JOIN ad_plays p ON p.id = c.ad_play_id JOIN sites s ON s.id = c.site_id
      WHERE COALESCE(p.started_at, p.scheduled_at) >= ? AND COALESCE(p.started_at, p.scheduled_at) < ?
      GROUP BY c.site_id, p.ad_id ORDER BY c.site_id`, from, to);
    const backup = this.db.all(`SELECT b.site_id, s.name, b.ad_id, COUNT(*) AS reproducciones, SUM(b.completed) AS completas
      FROM backup_ad_plays b JOIN sites s ON s.id = b.site_id WHERE b.started_at >= ? AND b.started_at < ? GROUP BY b.site_id, b.ad_id`, from, to);
    const songs = this.db.get("SELECT COUNT(*) AS n FROM program_items WHERE kind = 'song' AND status = 'emitido' AND actual_start >= ? AND actual_start < ?", from, to).n;
    return { date: dateLocal, timezone: tz, ads, perSite, backup, songsAired: songs };
  }

  csv(q) {
    const data = this.plays({ ...q, limit: 5000 });
    const tz = this.cfg.timezone;
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en Excel
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['id_evento', 'inicio_local', 'fin_local', 'comercial', 'anunciante', 'estado_central', 'duracion_esperada_s', 'duracion_emitida_s',
      'motivo_interrupcion', 'version_configuracion', 'secuencia_inicial', 'secuencia_final', 'sedes_conectadas_al_inicio', 'detalle_por_sede'];
    const lines = [head.join(';')];
    for (const p of data.items) {
      const detail = p.sites.map((s) => `${s.site}: ${s.status}${s.segmentsExpected ? ` (${s.segmentsSeen}/${s.segmentsExpected} segmentos)` : ''}`).join(' | ');
      lines.push([p.id, utcToLocalString(p.startedAt, tz), utcToLocalString(p.endedAt, tz), p.adName, p.advertiserName, p.status,
        p.expectedMs != null ? (p.expectedMs / 1000).toFixed(1) : '', p.observedMs != null ? (p.observedMs / 1000).toFixed(1) : '',
        p.interruptionReason, p.configVersion, p.firstSeq, p.lastSeq, p.sitesConnectedAtStart.length, detail].map(cell).join(';'));
    }
    return '﻿' + lines.join('\r\n') + '\r\n'; // BOM para que Excel en Windows respete las tildes
  }
}
