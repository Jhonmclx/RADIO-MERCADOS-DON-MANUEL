# Manual del administrador — RADIO MERCADO DON MANUEL

Este manual es para quien maneja la radio día a día desde el computador con Windows. No necesita conocimientos técnicos.

## Ideas clave

* La radio **vive en el servidor de Internet**, no en su computador. Puede cerrar el navegador o apagar el computador: las cinco sedes siguen sonando.
* Las cinco sedes reciben **la misma señal**. Lo que usted cambia en el panel llega a todas.
* Los cambios **nunca cortan** lo que está sonando (salvo que usted lo pida expresamente): se aplican en el siguiente turno.

## Entrar al panel

1. Abra en Chrome o Edge: `https://SU-DOMINIO/admin/`
2. Escriba su usuario y contraseña.
3. Si se equivoca muchas veces, el acceso se bloquea unos minutos por seguridad.

## Secciones

### Inicio
Muestra qué está al aire, qué sigue, el estado de la emisora, las cinco sedes y las alertas.
* **Conectada / Desconectada**: si el televisor de la sede se está comunicando con el servidor.
* **Reproduciendo**: el propio televisor informa que está reproduciendo. Si solo dice «Conectada», el panel no asegura que esté sonando.
* **Sonido bloqueado: pulse OK en el TV**: el televisor necesita que alguien pulse OK una vez en el control remoto.
* **Retraso / desvío**: cuánto va atrasado cada televisor respecto a la hora oficial y cuánto se aparta del objetivo común. «Desfase entre sedes» es la diferencia real medida entre la sede más adelantada y la más atrasada.

### Emisión y controles
* **Regla de publicidad**: cuántas canciones suenan antes de cada comercial (inicia en 2). Use − / + y pulse «Guardar regla».
* **Pausar la música**: deja de programar canciones; si hay comerciales activos, solo sonará publicidad.
* **Pausar la publicidad**: solo música (con el video del comercial en silencio de fondo). Un comercial que ya está sonando termina completo.
* **Pausar programación**: al terminar lo que suena, las sedes ven «Programación en pausa», sin sonido. Los televisores siguen conectados.
* **Detener toda la señal**: corta de inmediato en las cinco sedes. Pide escribir DETENER para confirmar. Para volver, pulse «Iniciar la emisión».

### Comerciales
**Subir un comercial**
1. Pulse «Elegir archivo» (recomendado: MP4 H.264 con audio AAC, de cualquier duración).
2. Escriba el nombre, elija el anunciante y la posición (al final o al inicio de la lista).
3. Deje marcado «Activar al terminar la validación» si quiere que entre a la rotación apenas esté listo.
4. Pulse «Subir». Verá el avance de la carga. Luego el sistema **valida** el archivo (estado «Validando…»). Si el archivo está dañado o no es compatible, aparecerá **Rechazado** con el motivo; no se emitirá.

**Ordenar**: arrastre ⠿ y suelte en la nueva posición. El nuevo orden se usa en el siguiente bloque.
**Frecuencia** (en «Editar»): 1 = normal. Con 2, sale el doble de veces que uno de frecuencia 1, sin salir dos veces seguidas cuando hay otros.
**Vigencia** (en «Editar»): fecha y hora de Colombia en que empieza y termina. Fuera de su vigencia no se programa.
**Desactivar**: elija «Al terminar» (recomendado; si está al aire termina completo) o «Inmediatamente» (se corta al aire y queda registrado como interrumpido). El historial **nunca** se borra.
**Reemplazar**: suba primero el comercial nuevo; luego, en el viejo, pulse «Reemplazar» y elija el nuevo. El viejo termina normalmente y el nuevo toma su lugar en el siguiente ciclo.
**Borrar**: solo es posible si el comercial nunca se emitió (para no perder reportes).

### Anunciantes
Registre cada negocio: nombre, contacto, teléfono, correo, vigencia y notas. Si un anunciante se desactiva o vence, sus comerciales dejan de salir.

### Música
* Suba uno o varios MP3 a la vez. El volumen se iguala automáticamente con el de los comerciales.
* **Habilitada**: si la canción entra en la programación.
* **Respaldo**: si se descarga en los televisores para sonar cuando una sede pierde Internet (solo en televisores compatibles).
* Ordene arrastrando ⠿. «Música en orden aleatorio» está en «Emisión y controles».
* Use solo música con los derechos de difusión correspondientes.

### Programación
* **Horario de emisión**: franjas por día (hora de Colombia). Fuera del horario las sedes muestran «Fuera del horario de emisión». Una canción o comercial que está sonando termina completo aunque se cumpla la hora.
* **Copiar el lunes a todos los días** ahorra tiempo. Pulse «Guardar horario».
* **Programar un cambio futuro**: por ejemplo, «el sábado a las 8:00, 1 canción entre comerciales». El servidor lo aplica solo, aunque el panel esté cerrado.

### Reportes
* Elija fechas, anunciante, comercial, sede y estado; pulse «Consultar».
* **Completado**: el comercial salió completo en la señal central (una emisión para las cinco sedes).
* **Interrumpido**: salió en parte (se indica el motivo y cuánto se emitió).
* Por sede: **Confirmada** = el televisor informó haber reproducido el comercial (90 % o más); **Parcial**; **Conectada, sin telemetría** = estaba conectada pero su navegador no informa el detalle; **Sin conexión**.
* **Exportar CSV**: abre en Excel con tildes correctas.
* Importante: el sistema prueba que el anuncio se **emitió y se reprodujo**, no que una persona lo haya visto.

### Registros
Motor y errores, emisión completa (as-run), eventos de sedes, acciones administrativas (quién hizo qué y cuándo) y diagnósticos de televisores.

### Cuenta
Cambie su contraseña (mínimo 10 caracteres con letras y números). Cerrar sesión no detiene la radio.

## Problemas frecuentes

| Situación | Qué hacer |
|---|---|
| Una sede aparece «Desconectada» | Revise Internet en la sede y que el televisor tenga abierta la página. Al volver Internet se reconecta sola. |
| «Sonido bloqueado: pulse OK en el TV» | Pulse OK en el control remoto del televisor de esa sede. |
| Un comercial quedó «Rechazado» | El archivo está dañado o en un formato no compatible. Expórtelo de nuevo como MP4 (H.264 + AAC) y súbalo otra vez. |
| La lista en vivo «Sin actualizar» | Revise «Registros → Motor y errores» y contacte al soporte técnico. |
| Olvidó la contraseña | El soporte técnico la restablece en el servidor con `npm run create-admin -- admin`. |
