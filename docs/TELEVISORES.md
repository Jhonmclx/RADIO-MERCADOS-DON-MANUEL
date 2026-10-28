# Televisores de las sedes — instalación, pruebas y limitaciones

## Abrir la radio en cada televisor

1. Conecte el televisor a Internet (cable de red preferiblemente; Wi-Fi estable si no hay cable).
2. Abra el **navegador** del televisor (Samsung: «Internet»; LG: «Navegador web»; Android/Google TV: Chrome u otro navegador instalado).
3. Escriba el enlace de su sede (cópielo desde el panel → Sedes):
   * `https://SU-DOMINIO/player/sede-1` … `https://SU-DOMINIO/player/sede-5`
4. Si aparece «Pulse OK para activar el sonido», pulse **OK** una vez en el control remoto.
5. Guarde la página como **favorita / página de inicio** para abrirla rápido al encender.
6. Desactive en el televisor el apagado automático de pantalla / modo ahorro de energía, si existe.

La página ocupa toda la pantalla, no muestra controles, se reconecta sola y muestra un indicador discreto arriba a la derecha (verde = en vivo; amarillo = reconectando o respaldo; rojo = sin señal).

## Diagnóstico de cada modelo

Antes de dejar el televisor instalado, abra en ese mismo televisor:

`https://SU-DOMINIO/diagnostico?sede=sede-1`

Pulse «Iniciar diagnóstico» y luego «Enviar resultado al panel». Verá (y quedará guardado en el panel):

* **Señal en vivo: COMPATIBLE / NO**: si el navegador reproduce la señal (por hls.js o HLS nativo).
* **Sonido automático**: si el televisor permite sonar sin pulsar nada o si exige pulsar OK al encender.
* **Respaldo local sin Internet: posible / no disponible**: requiere service worker, Cache Storage, HTTPS y espacio libre.
* Ajuste fino de velocidad (para sincronizar con suavidad), reloj del televisor, resolución, espacio disponible.

### Prueba recomendada por modelo (cuando se conozcan las marcas)
1. Diagnóstico completo y envío al panel.
2. Abrir la página de la sede 30 minutos: comprobar en el panel que aparezca «Reproduciendo», el retraso y el desvío.
3. Esperar un bloque comercial: en Reportes, la sede debe aparecer como «Confirmada» (si el navegador usa hls.js).
4. Desconectar el cable de red 1 minuto y volver a conectar: debe reconectarse solo y registrarse la reconexión.
5. Apagar y encender el televisor: anotar si abre la página sola y si hay que pulsar OK.
6. Dejarlo 8 horas seguidas y revisar que no se congele (algunos navegadores de TV tienen poca memoria).

Registre el resultado de cada modelo en una tabla (modelo, sistema, versión del navegador, resultados). Hasta hacer esto, **la compatibilidad con los televisores de las sedes no está comprobada.**

## Limitaciones conocidas (honestas)

* **Autoplay**: casi todos los navegadores bloquean el sonido automático hasta que alguien pulsa una tecla. El reproductor arranca la imagen en silencio y muestra «Pulse OK para activar el sonido». Tras apagar el televisor puede requerirse de nuevo. No es posible saltarse esta regla desde una página web.
* **Navegadores muy antiguos** (televisores de antes de ~2017): pueden no tener MSE ni HLS nativo; el diagnóstico lo dirá. Alternativa sin comprar computadores: un dispositivo de streaming económico (p. ej. un Android TV/Google TV, Fire TV o similar) conectado al televisor con su navegador; esto es una limitación de hardware, no del sistema.
* **Sincronización**: con hls.js se mide y corrige (dispersión ≈ 0,02–0,27 s en pruebas de escritorio). Con HLS nativo sin hora de cuadro (`getStartDate`) el retraso **no se puede medir** y el panel lo muestra como «no medido». Ningún reproductor HLS garantiza sincronía perfecta.
* **Respaldo local** (sonar sin Internet): solo si el navegador tiene service worker y Cache Storage, el sitio usa **HTTPS** y hay espacio. Si no, la sede muestra «Sin señal — reconectando» y vuelve sola. El respaldo se reporta aparte y nunca se confunde con la señal central.
* **Pantalla completa**: la mayoría de navegadores de TV ya muestran la página a pantalla completa; si no, se solicita al pulsar OK.
* **Suspensión**: si el televisor apaga la pantalla o el navegador por ahorro de energía, la reproducción se detiene; desactívelo en la configuración del televisor.
