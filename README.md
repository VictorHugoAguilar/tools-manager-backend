# Tool Management Backend

Backend API para gestionar herramientas con Firebase Realtime Database y estas propiedades:

- `id`
- `name`
- `type`
- `category`
- `description`
- `urlSrc`
- `state`
- `material`
- `long`

## Requisitos

- Node.js 22 o superior
- Proyecto Firebase con Realtime Database

## Instalacion

```bash
npm install
```

Crea tu archivo `.env` a partir de `.env.example` y configura la conexion:

```bash
cp .env.example .env
```

Variables disponibles:

- `PORT`: puerto del servidor
- `FIREBASE_DATABASE_URL`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_API_KEY`: clave pública usada por las conexiones Firebase del servidor
- `GOOGLE_APPLICATION_CREDENTIALS`: credencial de servicio para que el backend acceda a Realtime Database/Storage
- `FRONTEND_URL` y `FRONTEND_ORIGINS`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- `PUBLIC_REGISTRATION_ENABLED`

## Ejecucion

```bash
npm start
```

Modo desarrollo:

```bash
npm run dev
```

Para ejecutar los tests unitarios:

```bash
npm test
```

Si quieres subir el contenido actual de `data/tools.json` a Firebase:

```bash
npm run migrate:firebase
```

La API quedara disponible en:

`http://localhost:3000`

Ejemplo de configuracion:

```env
PORT=3000
FIREBASE_API_KEY=...
FIREBASE_DATABASE_URL=https://la-herreria-dev-default-rtdb.europe-west1.firebasedatabase.app
FIREBASE_PROJECT_ID=la-herreria-dev
FIREBASE_STORAGE_BUCKET=la-herreria-dev.firebasestorage.app
```

La aplicacion guarda las herramientas en el nodo `tools` de Realtime Database.
Las imagenes se suben a Firebase Storage en la carpeta `tools/<toolId>/`.

## Endpoints

### Telemetría (base experimental, incompleta)

#### Matriz de cobertura de monitorización y auditoría

Esta matriz define el alcance para completar la instrumentación; **propuesto**
no significa implementado. Las filas corresponden a las rutas y operaciones
vigentes, incluidos procesos automáticos. Cuando se habilita telemetría, las
peticiones HTTP terminadas se cuentan en métricas agregadas y los 5xx generan
`http.request.failed`, salvo las rutas de telemetría y monitorización, que se
excluyen para evitar bucles. Eso no equivale a auditoría de negocio ni a
trazabilidad completa.

Políticas acordadas: lecturas específicas solo para búsquedas y accesos
sensibles, además de métricas agregadas; preferencias personales y marcas de
lectura de notificaciones no requieren auditoría durable; en colaboración se
auditan hitos y cambios de acceso, no cada actualización WebSocket.

| Ámbito y operaciones | Cobertura actual | Objetivo y nombres de eventos propuestos |
|---|---|---|
| Herramientas: alta, edición, estado, referencia de imagen y eliminación | Auditoría experimental `AUDIT_TOOLS_ENABLED`; `tool.created`, `tool.updated`, `tool.state.updated`, `tool.image.updated`, `tool.deleted`. | Mantener eventos existentes; validar atomicidad, fallos y cambios concurrentes antes de activar. |
| Reparaciones de herramientas: alta, edición y eliminación | Auditoría experimental `AUDIT_REPAIRS_ENABLED`: `repair.created`, `repair.updated`, `repair.deleted`. | Validar en Firebase y bajo concurrencia; los eventos contienen identificadores de reparación y herramienta, nunca descripción o contenido. |
| Herramientas y reparaciones: listados y detalle | Métricas HTTP y 5xx generales. | Agregados; si una búsqueda se instrumenta, `tools.search.completed` sin términos ni resultados. No registrar cada lectura de rutina. |
| Técnicos, ubicaciones, tipos de herramientas y etiquetas: alta, edición y eliminación | Auditoría experimental `AUDIT_CATALOGS_ENABLED`: `technician.created/updated/deleted`, `location.created/updated/deleted`, `tool_type.created/updated/deleted` y `tag.created/updated/deleted`. | Validar en Firebase y bajo concurrencia. Los listados y detalles usan agregados. |
| Taller: estanterías, niveles, organizadores, compartimentos y materiales | Auditoría experimental `AUDIT_WORKSHOP_STORAGE_ENABLED` para alta, edición, eliminación y referencia de imagen; eventos `workshop.<colección>.created/updated/deleted` y `workshop.materials.image.updated`. | Conservar nombres existentes y validar toda la cobertura, incluidas condiciones de carrera y limpieza de imágenes. |
| Taller: categorías y lecturas | Categorías con auditoría experimental `workshop.category.created/deleted`; lecturas con `storage.workshop.viewed`, `storage.workshop.searched` y `storage.workshop.categories.viewed`. | Mantener las lecturas instrumentadas existentes y verificar que no contienen consulta ni resultados. |
| Cajas, productos e imágenes | Auditoría experimental `AUDIT_STORAGE_BOXES_ENABLED`: `box.created/updated/deleted`, `box.image.updated`, `box.product.created/updated/deleted` y `box.product.image.updated`. | Validar atómicamente cada cambio y sus referencias; la conciliación física de imágenes queda pendiente. |
| Cajas: configuración, listado, detalle y búsqueda | `box.shelf-config.updated` experimental; telemetría `storage.boxes.viewed`, `storage.box.viewed`, `storage.boxes.searched` y `storage.shelf_config.viewed`. | Mantener cobertura existente; no registrar términos ni identificadores en rutas de telemetría. |
| Tablero: columnas, orden y etiquetas | Auditoría experimental `AUDIT_TASK_BOARD_CATALOGS_ENABLED`: `task_board.column.created/updated/deleted/reordered` y `task_board.label.created/updated/deleted`. | Validar transacciones y concurrencia en Firebase. Lectura del tablero: agregados. |
| Tablero: tareas y movimientos | Auditoría experimental `AUDIT_TASK_BOARD_TASKS_ENABLED`: `task_board.task.created/updated/deleted/moved`. | Validar transacciones y concurrencia en Firebase. |
| Tablero: comentarios y adjuntos | Auditoría experimental `AUDIT_TASK_BOARD_TASKS_ENABLED`: `task_board.comment.created/updated/deleted` y `task_board.attachment.created/deleted`. | Validar la integración con Storage y diseñar la conciliación de archivos conservados; eventos sin texto, nombres ni URL. |
| Lista de tareas: proyectos, orden, archivo y miembros | Sin auditoría durable específica. | Auditoría `todo.project.created/updated/deleted/archived/reordered` y `todo.member.added/removed`. Lecturas: agregados; búsquedas selectivas sin términos. |
| Lista de tareas: secciones, tareas y subtareas | Sin auditoría durable específica. | Auditoría `todo.section.created/updated/deleted/reordered`, `todo.item.created/updated/deleted/completed/reopened/archived/importance.updated/priority.updated/moved/reordered/duplicated` y `todo.child.created/updated/deleted`. Los alias de proyectos deben producir el mismo evento. |
| Lista de tareas: etiquetas, comentarios, adjuntos y recordatorios | Sin auditoría durable específica. | Auditoría `todo.label.created/updated/deleted`, `todo.comment.created/updated/deleted`, `todo.attachment.created/deleted` y `todo.reminder.created/updated/deleted`. No guardar contenido, texto, nombres ni URL. |
| Lista de tareas: recurrencia, envío de recordatorios y notificaciones | Sin auditoría durable específica; existen procesos automáticos. | Diseñar eventos idempotentes `todo.recurrence.created` y `todo.reminder.delivered` para cambios de negocio confirmados por el sistema; separar fallos de entrega como telemetría `todo.reminder.delivery.failed`. Lectura de notificaciones y marca de leída: agregados, sin auditoría durable. El actor automático debe ser una identidad de sistema explícita, no un usuario inventado. |
| Dibujar: documentos y páginas | Sin auditoría durable específica. | Auditoría `drawing.document.created/updated/deleted/duplicated/archived/restored`, `drawing.page.created/updated/deleted/duplicated/reordered` y `drawing.version.restored`. Las consultas usan agregados y los accesos sensibles seleccionados telemetría. |
| Dibujar: snapshots, versiones, preferencias y recursos | Sin auditoría durable específica. | Auditar hitos de versión y carga/eliminación de recursos con `drawing.version.created` y `drawing.asset.created/deleted`, sin contenido ni URL. No auditar cada actualización colaborativa ni cada guardado automático como cambio individual; medir actividad agregada. Preferencias personales: agregados. Distinguir restauración explícita de guardados automáticos. |
| Dibujar: invitaciones, permisos y enlaces | Sin auditoría durable específica. | Auditoría `drawing.invitation.created/accepted/declined/cancelled`, `drawing.permission.updated/revoked` y `drawing.share_link.created/revoked`; identificar recurso y actor, sin tokens ni enlaces. Consultas y resolución de enlaces: telemetría selectiva sin secretos. |
| WebSocket de colaboración | Eventos experimentales de apertura, cierre, fallo de autenticación y carga/escritura; agregados de aperturas, cierres y actualizaciones. | Conservar los eventos existentes, añadir solo medidas fiables pendientes y probar correlación sin guardar mensajes, contenido o tokens. |
| Identidad: registro, reversión, recuperación, perfil y usuarios administrados | Auditoría experimental con banderas independientes para registro, recuperación, perfil y administración de usuarios; ver descripción de banderas más abajo. | Verificar cobertura de cada ruta y concurrencia. Registrar identificadores y tipos de acción, no contraseñas, hashes, tokens, nombres, correos ni imágenes. El actor de recuperación representa posesión del enlace, no una sesión. |
| Identidad: inicio/cierre de sesión, solicitudes de recuperación y autorizaciones denegadas | Métricas HTTP generales; sin catálogo específico de estos eventos en backend. | Telemetría selectiva `auth.login.succeeded/failed`, `auth.logout.completed`, `auth.password_reset.requested` y `auth.access.denied`; no registrar credenciales ni identidad no verificada. No convertir resultados de solicitud de recuperación en una señal de existencia de cuenta. |
| Roles y permisos | `role.permissions.updated` con auditoría experimental `AUDIT_ROLES_ENABLED`, incluyendo permisos efectivos anteriores y posteriores. Lecturas con agregados. | Mantener y probar protección, concurrencia y ausencia de datos de perfil. |
| Monitorización e historiales | Accesos a overview, eventos, trazas, métricas, servicios, estado de outbox e historiales se escriben directamente en `auditEvents` antes de leer; requieren `monitoring:app`. | Mantener el fallo cerrado, auditar nuevas consultas sensibles y probar autorización. No instrumentar esas rutas con la telemetría HTTP general. |
| Frontend y transporte de telemetría | Captura experimental de `frontend.runtime.error`, `frontend.api.request.failed` y `frontend.route.changed`; el endpoint valida un catálogo limitado. | Completar medidas reales de rendimiento y correlación; no asumir que las respuestas `202` ya están persistidas. Los eventos aceptados pero aún sin productor no cuentan como implementados. |

En los nombres propuestos, `created/updated/deleted` representa eventos
separados, no un nombre literal con barras. La implementación posterior debe
concretar el catálogo y su validación por acción, incluyendo actores y recursos
secundarios necesarios. Los eventos de auditoría actuales no llevan todos un
entorno ni un `traceId`; no atribuirlos retroactivamente sin verificar su origen.
El historial de almacenamiento se consulta en la base compartida y no filtra por
entorno. La separación real de entornos y el origen de registros históricos
siguen pendientes de comprobarse antes de ampliar su exposición o activación.

Para las lecturas sensibles pendientes se propone `admin.users.accessed`,
`admin.roles.accessed`, `drawing.permissions.accessed`,
`drawing.invitations.accessed` y `drawing.share_link.resolved`; estos son
eventos de telemetría, no auditorías durables. Deben identificar únicamente el
tipo de operación, resultado y correlación disponible, sin contenido ni
identificadores enviados por una persona no autenticada. Los accesos de
monitorización son la excepción: su registro durable previo a la lectura ya
está implementado. Las búsquedas específicas futuras se catalogarán por
funcionalidad y no almacenarán texto ni resultados.

El sobre previsto de auditoría contiene `schemaVersion`, `eventId`, `action`,
`actorId`, `targetId` y `occurredAt`, más identificadores secundarios
estrictamente necesarios y validados por acción. La futura extensión para
entorno y correlación deberá ser compatible con eventos ya pendientes y con el
publicador, y no modificará los registros históricos sin origen comprobado.
Las operaciones automáticas necesitan un actor de sistema identificable y
separado de usuarios; los intentos sin identidad verificada no deben atribuirse
a una cuenta. En telemetría se utiliza el contrato versionado existente,
con `service`, `environment`, nivel, tiempos y correlación cuando estén
disponibles; rutas normalizadas y atributos deben proceder de listas permitidas.

**Criterios de prueba por fila:** éxito y resultado previsto; ausencia de
secretos y contenido; autorización y denegación cuando corresponda; errores y
telemetría desactivada. Para auditoría, añadir pruebas de fallo de transacción
sin cambio ni evento, reintento, idempotencia, concurrencia y publicación tras
caída. Para procesos automáticos, probar identidad de sistema y ejecución
duplicada. Para archivos, probar también carreras y reconciliación con Storage.
Las suites existentes `test/telemetry`, `test/services`, `test/auth` y
`test/controllers` cubren partes de estos casos con dobles; las filas propuestas
necesitan pruebas propias y validación con Firebase emulado o real.

La ingesta y la cola de eventos de frontend están desactivadas por defecto mediante
`TELEMETRY_ENABLED=false`. El dashboard es preliminar: faltan la instrumentación
completa de la aplicación y métricas de frontend y WebSocket completas.
Las auditorías experimentales de
herramientas, permisos de roles y cambios de usuarios están
desactivadas por defecto. No debe considerarse una
solución de monitorización lista para producción.

La auditoría de negocio sigue incompleta. Existe una implementación experimental
para herramientas, desactivada por defecto con `AUDIT_TOOLS_ENABLED=false`.
Cuando se habilita, creación, modificación, cambio de estado, modificación de la
referencia de imagen y eliminación escriben el cambio en `tools` y un evento
en `auditOutbox` mediante una transacción en la raíz de Realtime Database. Los
eventos incluyen identificadores, acción y fecha, pero no nombres, imágenes ni
contenido de la herramienta. El proceso backend publica la outbox en Firestore
`auditEvents` cada cinco segundos y elimina cada entrada solo después de
confirmar la escritura; reintentos tras un fallo son idempotentes. Si una entrada
está dañada o entra en conflicto, se conserva y se registra el error. El
publicador sigue con las demás entradas del lote y recorre la cola por páginas
acotadas, volviendo al principio para reintentar las bloqueadas. Un fallo de
conexión interrumpe el lote y se reintenta; el cursor es local y se reinicia al
reiniciar el proceso. El orden de claves no es cronológico. Una comprobación
exitosa puede corresponder solo a una página y no demuestra que la cola entera
esté libre de entradas bloqueadas.

`AUDIT_REPAIRS_ENABLED=true` habilita experimentalmente la auditoría de altas,
ediciones y eliminaciones de reparaciones. El cambio y el evento se confirman
en la misma transacción; alta y edición comprueban de nuevo la herramienta y el
técnico dentro de ella. Los eventos incluyen identificadores, pero no nombres,
descripciones, costes ni observaciones.
Todos los procesos publicadores deben ejecutar una versión compatible con
`repair.*` antes de activar la bandera: los publicadores antiguos no reconocen
el nuevo campo `toolId` y conservarán esos eventos como inválidos.

`AUDIT_CATALOGS_ENABLED=true` habilita experimentalmente la auditoría de altas,
ediciones y eliminaciones de técnicos, ubicaciones, tipos de herramientas y
etiquetas. El cambio y el evento se confirman juntos; los eventos contienen
identificadores y acción, pero no nombres ni contenido. La creación de una
etiqueta duplicada devuelve la existente y una edición con nombre duplicado
devuelve conflicto, sin emitir eventos para esos casos. No habilitar antes de
validar las transacciones en Firebase y el aislamiento de entornos.

`AUDIT_TASK_BOARD_CATALOGS_ENABLED=true` habilita experimentalmente la auditoría
de creación, edición, ordenación y eliminación de columnas y de creación,
edición y eliminación de etiquetas del tablero. Los cambios y eventos se
confirman juntos en Realtime Database; los eventos no incluyen nombres ni
contenido. La bandera no cubre tareas, comentarios ni adjuntos del tablero.
Está desactivada por defecto y requiere validar el aislamiento de entornos y las
transacciones en Firebase antes de usarla.

`AUDIT_TASK_BOARD_TASKS_ENABLED=true` habilita experimentalmente la auditoría de
tareas, movimientos, comentarios y referencias de adjuntos del tablero. Los
cambios en RTDB y los eventos se confirman juntos; los eventos contienen solo
identificadores y acción, no títulos, comentarios, nombres ni URL de archivos.
Para evitar carreras con la edición de columnas y etiquetas, todas las instancias
deben ejecutar esta versión y activar también `AUDIT_TASK_BOARD_CATALOGS_ENABLED`.
El backend rechaza el arranque si se activa la auditoría de tareas sin la de
catálogos del tablero.
No habilitar antes de validar Firebase y el aislamiento de entornos.

Storage no participa en la transacción. Al eliminar un adjunto o una tarea con
adjuntos bajo esta bandera, se elimina la referencia de la tarea y se guarda
su ruta en `retainedTaskBoardAttachments` junto con el cambio y el evento; el
archivo físico **se conserva**. No existe aún un proceso de conciliación o
eliminación de estos archivos. Si falla la confirmación después de una subida,
también se conserva el archivo y se registra su identificador para revisión:
el resultado de una transacción fallida puede ser ambiguo. Esto puede dejar
archivos huérfanos y consumo de Storage; no eliminarlos sin verificar referencias
y concurrencia.

La auditoría experimental de cambios de permisos por rol se activa por separado
con `AUDIT_ROLES_ENABLED=true` (por defecto `false`). La modificación de
`authRoles` y su evento se escriben en la misma transacción; el evento registra
el actor, el rol y los identificadores de permisos efectivos antes y después,
como cadenas JSON ordenadas. No incluye nombres de usuarios, credenciales ni
datos del perfil. Si cambia un rol concurrentemente, el evento refleja el estado
previo de la transacción que finalmente se confirmó. La comprobación de permisos
obligatorios del rol administrador se mantiene.

La auditoría experimental de las acciones administrativas de usuarios se activa
con `AUDIT_ADMIN_USERS_ENABLED=true` (por defecto `false`). Cubre la creación,
edición y eliminación de usuarios, asignación de rol, cambio de estado,
restablecimiento administrativo de contraseña y actualización administrativa
del avatar. El cambio y el evento se confirman juntos en Realtime Database; los
eventos no contienen nombres, correos, contraseñas, hashes ni URL de imágenes.
Los cambios de rol y estado incluyen los valores anteriores y nuevos. Se
verifican dentro de la transacción la unicidad del correo, la existencia del rol,
el último administrador activo y la versión de sesión.

`AUDIT_SELF_USERS_ENABLED=true` habilita por separado la auditoría experimental
de edición del nombre propio, cambio de contraseña y avatar propio. La operación
y su evento se escriben en la misma transacción; solo se registran identificadores
y acción, nunca nombres, contraseñas, hashes ni URL. En esa fase se comprueba la
versión de sesión dentro de la transacción: si la cuenta se desactiva o cambia la
sesión durante la operación, se rechaza y se solicita iniciar sesión de nuevo.
`AUDIT_REGISTRATION_ENABLED=true` habilita experimentalmente la auditoría del
registro público y del avatar incluido en el alta. Si un paso posterior del
registro falla, la eliminación de compensación se audita como un evento
separado; si esa eliminación falla, queda el evento de alta y el error se
registra. El identificador de actor en el registro es el de la cuenta recién
creada, no una identidad autenticada previamente.

`AUDIT_PASSWORD_RECOVERY_ENABLED=true` habilita experimentalmente la auditoría
de recuperación de contraseña. El consumo del enlace, el cambio de contraseña,
la revocación por versión de sesión y el evento se confirman juntos en
Realtime Database. El identificador de actor es el de la cuenta recuperada y
representa el uso de un enlace válido, no una sesión autenticada. No se
almacenan en la auditoría ni el token, ni su hash, ni la contraseña.

El publicador se ejecuta cuando cualquiera de las doce banderas está activa y
procesa toda la outbox, con independencia del tipo de evento. Al desactivar
las doce banderas se detiene el publicador; las entradas pendientes permanecen en
Realtime Database y se reanudan al volver a habilitar al menos una bandera.
El panel consulta `GET /api/monitoring/audit-status`, protegido por
`monitoring:app` y auditado antes de leer la outbox. Muestra el número de
entradas pendientes hasta 100; si hay más, muestra «Al menos 100». La lectura
abarca la outbox compartida de la base, no un entorno concreto, mientras que el
estado y los fallos del publicador corresponden exclusivamente a la instancia
del backend que respondió. Una comprobación correcta puede encontrar la cola
vacía; no demuestra que todas las acciones estén auditadas ni que funcionen
otras instancias. Los contadores y fechas locales se reinician al reiniciar el
proceso. Una consulta fallida se muestra como error, no como cola vacía.
Una entrada aún pendiente en Realtime Database podría haberse publicado ya en
Firestore si falló la confirmación de su eliminación de la outbox.

Con `TELEMETRY_ENABLED=true`, las lecturas y búsquedas de almacenamiento del
taller y de cajas generan eventos de monitorización con ruta normalizada,
estado, duración, actor y correlación de la petición. No registran términos de
búsqueda ni identificadores de cajas en la ruta. Estos eventos usan la cola de
telemetría y pueden perderse: no constituyen una auditoría durable. La
instrumentación de lecturas es independiente de la auditoría de cambios.

`AUDIT_WORKSHOP_STORAGE_ENABLED=true` activa la auditoría
experimental para altas, ediciones y eliminaciones de estanterías, niveles,
organizadores, compartimentos, materiales y categorías, así como cambios de
referencia de imagen de material. `AUDIT_STORAGE_BOXES_ENABLED=true` habilita
por separado la auditoría de cajas, productos, referencias de imágenes y la
configuración de estantes. Cada cambio y evento se confirman juntos en la raíz
de Realtime Database. No cubren otros servicios como etiquetas. Con estas
opciones activas, las imágenes antiguas no se eliminan automáticamente, y las
cargas fallidas pueden dejar objetos huérfanos: todavía falta una conciliación
segura con Storage.

Las páginas de almacenamiento permiten consultar los últimos 25 cambios
publicados, solo a usuarios con `monitoring:app`. El acceso al historial se
audita en Firestore antes de leerlo. Los eventos pendientes en la outbox,
los anteriores a la introducción de `auditScope` y los cambios realizados con
auditoría desactivada no aparecen. El historial corresponde a toda la base
compartida y no está aislado por entorno; tampoco incluye lecturas, que usan la
telemetría no durable. La consulta requiere desplegar el índice `auditEvents`
definido en `firestore.monitoring.indexes.json`; un fallo de consulta se muestra
explícitamente y no implica un historial vacío.
El índice de historial utiliza la colección `auditEvents`, `auditScope`
ascendente y `occurredAt` descendente; Firestore añade `__name__` descendente.
Debe estar habilitado en el proyecto utilizado por el backend, no solo definido
en el archivo local.

Esta opción mantiene las rutas actuales, pero cada transacción afecta a la raíz
completa y puede entrar en conflicto con escrituras de otras funcionalidades.
La implementación rechaza cambios auditados cuando la raíz serializada supera
8 MiB, antes y después del cambio; la acumulación de la outbox también consume
espacio. Firebase limita a 16 MB una solicitud de escritura desde los SDK.
**No activar en producción** sin verificar el tamaño real, las reglas y permisos,
la carga, los límites y la recuperación mediante emuladores y pruebas de
concurrencia. Storage y Realtime Database no comparten transacciones: la subida
o eliminación física de imágenes puede fallar por separado y aún necesita
conciliación durable. Tampoco se ha probado esta fase contra Firebase real.

La ruta `/monitorizacion` requiere el permiso `monitoring:app`, verificado también
en `GET /api/monitoring/overview`. El catálogo incorpora los permisos nuevos al
iniciar el backend sin modificar permisos de roles existentes: un administrador
debe asignar explícitamente `monitoring:app` al rol deseado y el usuario debe
volver a consultar su perfil. Cada consulta escribe primero un evento durable de
acceso en `auditEvents`; si la auditoría falla, no se entregan datos. Firestore
debe estar habilitado y las credenciales de servidor deben poder leer eventos y
escribir la auditoría. Cada actualización genera un acceso auditado. La interfaz
muestra hasta 25 eventos de la última hora, 24 horas o 7 días y la salud del
recolector de la instancia que responde, no la del conjunto de instancias.
Las métricas y estados sin fuente aparecen como «Sin datos».

La sección de logs permite buscar por intervalo, servicio, nivel, nombre exacto
de evento y `traceId`. La API `GET /api/monitoring/events` exige `from` y `to`
UTC ISO-8601, limita el intervalo a siete días y devuelve hasta 25 resultados y
un cursor para la siguiente página. Filtra por el entorno del servidor, requiere
`monitoring:app` y registra el acceso en `auditEvents` antes de leer. No ofrece
búsqueda de texto libre ni filtros por usuario o ruta en esta fase. El cursor
identifica el último evento de la página y solo es válido con los mismos filtros
y fechas; si ese documento se elimina por TTL se debe iniciar una nueva búsqueda.
`GET /api/monitoring/traces/:traceId` utiliza el mismo rango y paginación para
consultar una traza concreta, y también audita el acceso.

`GET /api/monitoring/metrics` requiere `from` y `to` en el mismo formato UTC,
un intervalo entre un minuto y siete días, `interval=1m|1h` y una de las parejas
`service=backend&metric=http_requests` o
`service=websocket&metric=websocket_activity`. Devuelve solo minutos completos;
los grupos horarios en los extremos pueden ser parciales. La ausencia de
intervalos no implica cero actividad. `GET /api/monitoring/services` devuelve
las señales recientes de backend y WebSocket; frontend y almacenamiento son
`null` porque no se ha medido su disponibilidad. Ambos endpoints exigen
`monitoring:app` y registran el acceso antes de consultar Firestore.

Las consultas necesitan los índices compuestos de
`firestore.monitoring.indexes.json`. Incorpóralos a la configuración de índices
de Firestore del proyecto y despliega esa configuración con Firebase CLI antes
de usar los filtros; combinar con cualquier configuración de índices existente,
no sustituirla sin revisarla. La creación de índices puede tardar varios minutos.
La consulta inicial necesita un índice de `monitoringEvents` con
`environment` ascendente y `receivedAt` descendente (Firestore añade
`__name__` descendente). Si Firestore devuelve un enlace para crearlo, ábrelo
con una cuenta autorizada en el proyecto correcto, confirma la creación y espera
a que el índice esté habilitado. Crear solo ese índice permite superar el primer
error, pero las búsquedas y consultas de métricas o heartbeats pueden necesitar
los demás índices del archivo. Para el resumen también se necesitan los índices
de `monitoringMetricBuckets` (`environment`, `metricName`, `service` e
`intervalStart`, todos ascendentes) y `monitoringInstances` (`environment`
ascendente y `heartbeatAt` descendente). Cada uno debe estar habilitado en el
proyecto al que apunta el backend. Un índice ausente o en construcción devuelve
`503 MONITORING_INDEX_UNAVAILABLE`, sin exponer enlaces ni detalles internos
al navegador; el servidor conserva el error original en sus registros.

Con telemetría habilitada en cada proceso, el backend y el servidor WebSocket
publican un heartbeat en `monitoringInstances` al comenzar a escuchar y después
cada 30 segundos, con timestamp asignado por Firestore. El panel considera
recientes las señales de los últimos 120 segundos; una señal reciente solo
indica que una instancia pudo escribir en Firestore, no que el servicio esté
disponible para usuarios. Una señal antigua o ausente tampoco demuestra por sí
sola que el servicio esté caído. Se muestra la última señal de las instancias
consultadas en las últimas 48 horas, separadas por entorno; la consulta falla
explícitamente si supera 500 documentos en lugar de devolver un conteo parcial.
La salud del heartbeat en el recolector corresponde solo a la instancia que
responde. Configura el TTL de Firestore en `expiresAt` para
`monitoringInstances` (retención asignada de 48 horas) y conserva el índice
de campo único para `heartbeatAt`. La expiración TTL es eventual.

El backend agrega por minuto y por instancia las peticiones HTTP completadas
(exceptuadas las rutas de telemetría y monitorización), sus respuestas 5xx y
duraciones. Los intervalos cerrados se almacenan en `monitoringMetricBuckets`;
el panel suma las instancias del entorno actual y representa la latencia media.
Solo se incluyen minutos completos dentro del intervalo seleccionado: los datos
del minuto en curso no aparecen hasta cerrarse. La ausencia de una muestra no se
interpreta como disponibilidad ni como cero peticiones. El p95 y el p99 se muestran como
rangos estimados a partir del histograma, no como mediciones exactas. Los
recuentos no representan usuarios y los errores 4xx no se cuentan como 5xx.

Las métricas utilizan memoria acotada y reintentos limitados, por lo que pueden
perderse en reinicios o ante fallos prolongados; el panel muestra los descartes
de la instancia que responde. Cada consulta limita la lectura a 25.000 intervalos
y devuelve un error explícito si se supera ese límite, sin mostrar sumas
incompletas. Configura la política TTL de Firestore en `expiresAt` también para
`monitoringMetricBuckets` (retención asignada de 90 días). El campo `intervalStart`
debe conservar su índice de campo único. El almacenamiento y costes de Firestore
dependen del tráfico y número de instancias.

Al activarla, `POST /api/telemetry/events` requiere sesión, `app:access` y CSRF,
acepta lotes JSON de hasta 50 eventos y 64 KiB, y limita las solicitudes por
usuario y proceso. La respuesta `202` indica únicamente la aceptación en la cola
local volátil, no la persistencia en Firestore. La cola prioriza WARN y ERROR,
tiene capacidad y reintentos limitados y puede perder datos al reiniciar. Este
primer recolector acepta únicamente los nombres del catálogo de frontend y los
campos `schemaVersion`, `eventId`, `occurredAt`, `eventName`, `traceId` y
`durationMs`; no acepta atributos ni datos personales arbitrarios.

El cliente Angular dispone de captura experimental de errores globales,
fallos HTTP y navegación, desactivada por defecto con `telemetryEnabled: false`
en sus archivos de entorno. Para probarla hay que habilitarla en el entorno
correspondiente, reconstruir el frontend y habilitar también `TELEMETRY_ENABLED`
en el backend. El navegador necesita un contexto seguro para generar UUID.
Los eventos se generan únicamente con una sesión conocida; no incluyen la URL,
el mensaje o stack del error, cuerpos ni credenciales. Las peticiones a la API
reciben un `X-Trace-Id` independiente, pero el endpoint de telemetría y los
orígenes externos quedan excluidos.

El cliente usa un búfer limitado a 200 eventos, envía hasta 25 cada cinco
segundos o al alcanzar ese tamaño y conserva primero los errores bajo presión.
Reintenta hasta tres veces con espera creciente; un cambio de usuario descarta
el búfer anterior. Al ocultarse o cerrarse la página intenta enviar lo pendiente
con `fetch` y `keepalive` solo si el token CSRF ya está disponible; ese envío no
está garantizado. Los eventos rechazados por el servidor no se reintentan
individualmente porque la respuesta solo informa de cantidades. El cierre
brusco o los fallos prolongados pueden perder datos.

El proceso de colaboración WebSocket usa su propia cola y worker cuando
`TELEMETRY_ENABLED=true` está configurado en ese proceso. Registra aperturas y
cierres de conexiones colaborativas, fallos de autenticación y errores al cargar
o guardar documentos. Cada conexión recibe un identificador aleatorio para
relacionar apertura y cierre; no se registran usuarios, salas, tokens, mensajes
ni contenido de los dibujos. Los eventos son volátiles hasta su escritura y
pueden perderse en reinicios o fallos de Firestore. Por cada minuto con
actividad, se guardan por instancia contadores de aperturas, cierres y
actualizaciones recibidas en `monitoringMetricBuckets`; no se almacenan los
mensajes. El panel suma los intervalos cerrados del entorno seleccionado,
pero los huecos no demuestran inactividad y los recuentos pueden ser
incompletos por reinicios, desbordamientos o fallos de escritura. Cada heartbeat del
proceso informa también de la salud de su agregador; el panel solo suma datos
de instancias recientes y señala cuando falta esa información. No puede informar
de pérdidas de procesos que ya no envían señales. Cada heartbeat del
proceso WebSocket incluye el número actual de conexiones colaborativas lógicas
(una conexión a una sala, no usuarios únicos ni necesariamente sockets físicos)
y contadores acumulados de aperturas, cierres y actualizaciones recibidas desde
el inicio del proceso. No se contabilizan todos los mensajes del protocolo.
El panel suma conexiones únicamente de instancias con señal reciente; excluye
instancias sin señal y la cifra puede ser parcial o tener hasta 120 segundos de
antigüedad. Si una instancia reciente no informa el dato, se muestra «Sin datos».
No representa disponibilidad ni garantiza que no existan otras instancias.

Con telemetría habilitada, el middleware HTTP asigna `x-trace-id` y `x-request-id`
y encola las respuestas 5xx con método, ruta declarada sin parámetros concretos,
estado y duración; no registra cuerpos ni cadenas de consulta. Las rutas de
ingesta y monitorización están excluidas para evitar recursión. Las respuestas
correctas se incluyen en las métricas agregadas, sin guardar un evento por cada petición.

La escritura usa Firebase Admin y la base de datos Firestore predeterminada del
proyecto. Requiere que Firestore y los permisos IAM estén configurados; antes de
habilitarla se deben denegar accesos directos de clientes a las colecciones de
monitorización y configurar la política TTL de Firestore en `expiresAt` para
`monitoringEvents`. El código asigna 14 días a DEBUG/INFO y 30 a WARN/ERROR, pero
Firestore no aplica TTL automáticamente sin dicha configuración. Los ajustes
`TELEMETRY_QUEUE_MAX_ITEMS`, `TELEMETRY_BATCH_MAX_ITEMS`,
`TELEMETRY_FLUSH_INTERVAL_MS`, `TELEMETRY_RETRY_MAX_ATTEMPTS` y
`TELEMETRY_RETRY_BASE_DELAY_MS` controlan el recolector.

### Autenticación y usuarios

Las cuentas de la aplicación usan credenciales propias, verificadas por la API; no se usa Firebase Authentication ni inicio de sesión de Google para identificar a los usuarios. Los perfiles y hashes de contraseña (scrypt con salt aleatorio) están en `authUsers`; los roles y permisos en `authRoles` y `authPermissions`; las sesiones y los tokens de recuperación se guardan como hashes en `authSessions` y `authPasswordResets`. No se añade una base SQL ni se modifica el almacenamiento de herramientas/taller. La carga existente de imágenes puede usar una identidad anónima de Firebase Storage según la configuración del bucket.

El servidor verifica sesiones opacas mediante una cookie `HttpOnly`, con expiración y revocación al cambiar contraseña o estado, y protege las solicitudes de escritura con un token CSRF de doble envío. Las rutas de inventario existentes requieren una sesión válida y el permiso `app:access`. Las rutas de administración requieren los permisos correspondientes.

| Método | Ruta | Acceso | Función |
|---|---|---|---|
| POST | `/api/auth/register` | Público si está habilitado | Alta con rol `user` e inicio de sesión |
| POST | `/api/auth/login` | Público | Inicio de sesión |
| POST | `/api/auth/password-reset` | Público | Solicita instrucciones para restablecer la contraseña |
| POST | `/api/auth/password-reset/complete` | Público | Establece contraseña usando el token de un solo uso |
| POST | `/api/auth/logout` | Sesión | Cierre y revocación de sesiones |
| GET | `/api/auth/me` | Sesión | Usuario de la sesión |
| GET/PATCH | `/api/users/me` | Sesión | Consultar/actualizar nombre y apellido |
| PATCH | `/api/users/me/password` | Sesión | Cambiar contraseña revalidando la actual |
| POST | `/api/users/me/avatar` | Sesión | Subir avatar JPEG, PNG o WebP (máx. 3 MB) |
| GET | `/api/admin/users` | `users:manage` | Listado con búsqueda, filtros y paginación |
| GET/POST | `/api/admin/users` | `users:manage` | Consultar/crear usuarios |
| GET/PATCH/DELETE | `/api/admin/users/:id` | `users:manage` | Consultar/editar/eliminar usuario |
| PATCH | `/api/admin/users/:id/role` | `users:manage` | Asignar rol |
| PATCH | `/api/admin/users/:id/status` | `users:manage` | Activar/desactivar cuenta |
| PATCH | `/api/admin/users/:id/password` | `users:manage` | Establecer contraseña nueva y revocar sesiones |
| POST | `/api/admin/users/:id/avatar` | `users:manage` | Actualizar avatar de usuario |
| GET | `/api/admin/roles` | `roles:manage` | Consultar roles |
| GET | `/api/admin/permissions` | `roles:manage` | Consultar catálogo de permisos |
| PATCH | `/api/admin/roles/:roleId/permissions` | `roles:manage` | Asignar permisos existentes a un rol |

El listado acepta `search`, `role`, `status=active|inactive`, `sort`, `order=asc|desc`, `page` y `limit` (máximo 100). El correo es inmutable desde el perfil propio; un administrador puede cambiarlo y la API mantiene la unicidad.

### Listas de tareas

El tablero es independiente del inventario y se guarda en el nodo `taskBoard` de Firebase Realtime Database. Las columnas y etiquetas iniciales se crean una sola vez. Los adjuntos se guardan en Firebase Storage bajo `task-board/<taskId>/` (máximo 15 MB por archivo). Todos estos endpoints requieren sesión y permiso `app:access`; las escrituras también requieren el token CSRF de la aplicación.

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/task-board` | Obtener columnas, tareas, etiquetas y responsables; acepta filtros por búsqueda, lista, prioridad, etiqueta, responsable y vencimiento |
| POST/PATCH/DELETE | `/api/task-board/columns` y `/api/task-board/columns/:id` | Crear, actualizar o eliminar listas |
| PUT | `/api/task-board/columns/reorder` | Reordenar listas |
| POST/PATCH/DELETE | `/api/task-board/tasks` y `/api/task-board/tasks/:id` | Crear, actualizar o eliminar tareas |
| POST | `/api/task-board/tasks/:id/move` | Mover y reordenar una tarea |
| POST | `/api/task-board/tasks/:id/comments` | Añadir un comentario |
| POST/DELETE | `/api/task-board/tasks/:id/attachments` y `/api/task-board/tasks/:id/attachments/:attachmentId` | Subir o eliminar un adjunto |
| POST/PATCH/DELETE | `/api/task-board/labels` y `/api/task-board/labels/:id` | Crear, actualizar o eliminar etiquetas |

### Configuración inicial de autenticación

1. Copia `.env.example` a `.env` y configura Firebase Realtime Database y Storage. El backend sigue necesitando credenciales de servicio (`GOOGLE_APPLICATION_CREDENTIALS` o ADC) para acceder a Firebase; esas credenciales son para la base/Storage, no para autenticar a las personas.
2. Configura SMTP y `FRONTEND_URL` para enviar enlaces de recuperación de un solo uso, válidos durante 30 minutos.
3. Define `FRONTEND_ORIGINS` con los orígenes permitidos, separados por comas. En desarrollo se usa `http://localhost:4200`.
4. El registro público está deshabilitado por defecto. Para habilitarlo, establece `PUBLIC_REGISTRATION_ENABLED=true`; los registros solo pueden obtener el rol de usuario.
5. Crea el primer administrador desde una terminal interactiva:

   ```bash
   npm run bootstrap:admin -- "Nombre" "Apellido" admin@example.com
   ```

   El comando solicita la contraseña sin mostrarla y no permite crear un segundo administrador inicial. Si se ejecuta con el correo del administrador que ya existía en el perfil antiguo, le establece una contraseña nueva para el sistema de autenticación propio. No se asignan privilegios de administrador durante el registro público.
6. Las contraseñas anteriores no se pueden importar. Las cuentas existentes podrán crear una contraseña propia con «¿Has olvidado tu contraseña?» (requiere SMTP); también se puede asignar desde la gestión de usuarios. Hasta establecerla, no podrán iniciar sesión.
7. Inicia el servidor con `npm start`. Al arrancar se inicializan los roles y permisos predeterminados de forma idempotente.

Las contraseñas deben tener entre 10 y 128 caracteres e incluir letras y números. Los cambios de cuenta, rol y estado requieren confirmación de autorización en el backend. El último administrador activo no se puede degradar, desactivar ni eliminar; tampoco se permite que el administrador elimine o desactive su propia cuenta.

### Obtener todas las herramientas

```http
GET /api/tools
```

Tambien puedes buscar por diferentes criterios usando query params:

```http
GET /api/tools?name=taladro
GET /api/tools?type=electrica&state=disponible
GET /api/tools?category=construccion&material=acero
GET /api/tools?description=pared
GET /api/tools?q=martillo&minLong=20&maxLong=40
GET /api/tools?sortBy=name&sortOrder=asc
GET /api/tools?page=1&limit=5
GET /api/tools?state=disponible&sortBy=long&sortOrder=desc&page=1&limit=10
```

Si usas paginacion, la respuesta devuelve:

```json
{
  "items": [],
  "meta": {
    "totalItems": 0,
    "totalPages": 0,
    "currentPage": 1,
    "limit": 10,
    "hasNextPage": false,
    "hasPreviousPage": false
  }
}
```

### Obtener una herramienta por ID

```http
GET /api/tools/:id
```

### Crear una herramienta

```http
POST /api/tools
Content-Type: application/json
```

Ejemplo de body:

```json
{
  "name": "Taladro percutor",
  "type": "Electrica",
  "category": "Construccion",
  "description": "Taladro con percutor para pared y hormigon",
  "urlSrc": "https://example.com/taladro.jpg",
  "state": "Disponible",
  "material": "Acero",
  "long": 32.5
}
```

### Actualizar una herramienta

```http
PUT /api/tools/:id
Content-Type: application/json
```

### Cambiar solo el estado de una herramienta

```http
PATCH /api/tools/:id/state
Content-Type: application/json
```

Ejemplo de body:

```json
{
  "state": "Prestada"
}
```

### Subir o reemplazar la imagen de una herramienta

```http
POST /api/tools/:id/image
Content-Type: multipart/form-data
```

El campo del formulario debe llamarse `image`.

Ejemplo con `curl`:

```bash
curl -X POST http://localhost:3000/api/tools/TOOL_ID/image \
  -F "image=@/ruta/a/imagen.jpg"
```

La API actualiza automaticamente `urlSrc` con la URL publica devuelta por Firebase Storage.

### Eliminar la imagen de una herramienta

```http
DELETE /api/tools/:id/image
```

Ejemplo con `curl`:

```bash
curl -X DELETE http://localhost:3000/api/tools/TOOL_ID/image
```

La API limpia `urlSrc` y, si la imagen estaba en Firebase Storage, elimina tambien el archivo.

### Eliminar una herramienta

```http
DELETE /api/tools/:id
```

## Inventario del taller

Este módulo es independiente del almacenamiento de cajas existente. Usa el nuevo nodo
`workshopStorage` de Realtime Database, organizado en colecciones separadas:

- `workshopStorage/shelves`
- `workshopStorage/levels`
- `workshopStorage/organizers`
- `workshopStorage/compartments`
- `workshopStorage/materials`

Realtime Database no usa tablas SQL; estas colecciones son los nuevos conjuntos de datos
del módulo. Los materiales apuntan a compartimentos y las ubicaciones se resuelven mediante
las relaciones compartimento → organizador → balda → estantería. Por ello, recolocar un
organizador no modifica el inventario.

La API nueva está bajo `/api/workshop-storage`:

- `GET /` devuelve la configuración y el inventario.
- `GET /search?q=...` busca por nombre, categoría y características técnicas.
- Para cada colección (`shelves`, `levels`, `organizers`, `compartments`, `materials`):
  `POST /<colección>`, `PUT /<colección>/:id` y `DELETE /<colección>/:id`.
- `POST /materials/:id/image` sube o reemplaza la fotografía del material.

Las eliminaciones de estructura con elementos dependientes se rechazan para evitar perder
referencias o inventario. Hay que retirar o recolocar primero los elementos dependientes.
Las medidas de ancho y fondo de baldas y organizadores son opcionales; cuando se indican
ambas, la API comprueba que el organizador quepa, permitiendo girarlo 90 grados.

Las categorías editables de los materiales se guardan por separado en
`workshopStorageSettings/materialCategories`. Se pueden consultar con
`GET /api/workshop-storage/categories`, crear con `POST /api/workshop-storage/categories`
(`{ "name": "Adhesivos" }`) y eliminar con
`DELETE /api/workshop-storage/categories/:id`. La primera configuración ofrece Tornillos,
Tuercas, Arandelas, Tacos, Piezas eléctricas y Otros. Retirar una opción no modifica los
materiales ya registrados con esa categoría.
