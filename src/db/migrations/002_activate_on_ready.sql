-- Permite que un comercial recién subido entre a la rotación automáticamente al terminar su validación.
ALTER TABLE ads ADD COLUMN activate_on_ready INTEGER NOT NULL DEFAULT 0;
