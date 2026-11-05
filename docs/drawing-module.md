# Módulo Dibujar

## Arquitectura

El módulo usa la API Express existente para operaciones autenticadas y un proceso Hocuspocus independiente para colaboración en tiempo real. Ambos procesos utilizan Firebase Realtime Database; los cambios del lienzo se sincronizan con Yjs y se persisten como estado colaborativo y snapshots de historial.

La API de dibujo está montada bajo `/api/drawing`. Sus endpoints requieren sesión válida y permiso global `app:access`; las escrituras HTTP también requieren el mecanismo CSRF de la aplicación. La conexión WebSocket usa sesiones de colaboración de vida corta, generadas por la API y verificadas contra Firebase. Las conexiones revalidan permisos y estado de cuenta; una revocación cierra la sesión. Los enlaces compartidos conceden acceso de solo lectura.

## Permisos

| Rol | Acceso |
|---|---|
| Owner | Control total de la pizarra, permisos, invitaciones y enlace compartido |
| Editor | Lectura, edición y presencia colaborativa |
| Viewer | Lectura y presencia, sin cambios al contenido |
| Enlace compartido | Viewer, sin necesidad de pertenecer a la pizarra |

El propietario se deriva de la sesión autenticada. Los Editores no pueden modificar metadatos de la pizarra ni administrar accesos. El servidor también vuelve a comprobar el rol antes de aceptar cambios Yjs; no confía en el estado de solo lectura del cliente.

## Datos en Firebase

No se crean tablas SQL ni se duplica el sistema de usuarios. Los datos del módulo se guardan bajo `drawing/`:

- `documents`, `documentsByOwner`, `pages`, `pagesByDocument`, `pagesByUser`: pizarras, páginas y sus índices.
- `snapshots`, `versionsByPage`: snapshots validados e historial.
- `preferences`: cámara, fondo, cuadrícula y ajuste por página/usuario.
- `assets`, `assetsByDocument`: metadatos de recursos; los objetos rasterizados se guardan en Firebase Storage.
- `access/{documentId}`: permisos e invitaciones de una pizarra.
- `accessByUser`, `permissionsById`, `invitationsByRecipient`, `invitationLookup`: índices para listar y resolver accesos.
- `shareLinks/{documentId}`, `shareLinksByToken`: enlaces activos; solo se guarda el hash del token.
- `collaborationSessions/{tokenHash}`: sesiones temporales WebSocket, con token almacenado como hash.
- `collaborationStates/{documentId}/{pageId}`: actualización Yjs, snapshot validado y datos del último checkpoint.
- `accessAudit`: registro de invitaciones, cambios de permisos y uso/revocación de enlaces.

Las pizarras se eliminan lógicamente. Los snapshots tienen un límite de 750 KiB y 2.500 objetos. Los recursos rasterizados admitidos son PNG, JPEG y WebP, hasta 10 MB.

## API

Además de los endpoints de pizarras, páginas, snapshots, versiones, preferencias y recursos descritos en el router:

| Método | Ruta | Acceso / función |
|---|---|---|
| GET | `/users/search` | Buscar usuarios activos para invitar |
| GET | `/invitations` | Listar invitaciones recibidas |
| POST | `/invitations/:invitationId/accept` | Aceptar una invitación |
| POST | `/invitations/:invitationId/decline` | Rechazar una invitación |
| DELETE | `/invitations/:invitationId` | Cancelar invitación (Owner) |
| GET | `/documents/:documentId/permissions` | Listar miembros (Owner) |
| POST / GET | `/documents/:documentId/invitations` | Crear/listar invitaciones (Owner) |
| PATCH / DELETE | `/permissions/:permissionId` | Cambiar rol/revocar miembro (Owner) |
| GET / POST / DELETE | `/documents/:documentId/share-link` | Consultar/crear/revocar enlace (Owner) |
| POST | `/share-links/resolve` | Resolver un enlace de solo lectura |
| POST | `/documents/:documentId/collaboration-session` | Crear una sesión temporal para una página |

Los guardados del lienzo colaborativo se confirman después de persistir el estado Yjs. Se crean checkpoints de historial de forma periódica. Las invitaciones caducan a los siete días y los enlaces pueden tener una caducidad máxima de 90 días.

## Ejecutar y desplegar colaboración

Se requiere Node.js 22 o superior. La API y el proceso WebSocket se ejecutan por separado y deben compartir la configuración de Firebase:

```bash
npm start
npm run start:collaboration
```

Configura `DRAWING_COLLAB_HOST` y `DRAWING_COLLAB_PORT` para el proceso WebSocket. Configura `FRONTEND_ORIGINS` con los orígenes frontend permitidos, separados por comas. El servidor de producción debe exponer WebSocket seguro (`wss://`) y la URL debe coincidir con `drawingCollaborationUrl` en el entorno de producción del frontend. La URL incluida actualmente en ese entorno es `wss://tools-manager-collaboration.onrender.com`; debe reemplazarse si el servicio se publica en otro host.

El proceso Hocuspocus es una instancia independiente: no se inicia automáticamente con Express. Debe desplegarse, mantenerse activo y tener acceso a Firebase antes de habilitar la colaboración en producción.

## Alcance del editor

El editor integra colaboración Yjs, undo colaborativo, indicadores de presencia y cursores remotos. Conserva biblioteca, formas básicas, texto, dibujo libre, selección, zoom/pan, cuadrícula, autosave, páginas, historial, importación JSON y exportación JSON/PNG.

La interfaz todavía no inserta imágenes en el lienzo. SVG/PDF, plantillas, miniaturas persistidas, agrupación/alineación, conectores anclados y capas avanzadas no forman parte del editor actual. El SDK Konva está bajo licencia MIT; el SDK tldraw no se utiliza.
