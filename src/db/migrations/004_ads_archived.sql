-- Permite eliminar del panel comerciales que ya tienen historial: se ocultan y se borran sus archivos,
-- pero el registro se conserva para que los reportes sigan mostrando su nombre.
ALTER TABLE ads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
