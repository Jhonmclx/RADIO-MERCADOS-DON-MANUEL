-- Comerciales por sede: si un comercial tiene filas aquí, SOLO se muestra en esas sedes (p. ej. precios del Terminal).
-- Sin filas = todas las sedes (como antes).
CREATE TABLE ad_sites (
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (ad_id, site_id)
);
CREATE INDEX ad_sites_site ON ad_sites(site_id);
