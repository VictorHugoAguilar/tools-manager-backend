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

- Node.js 20 o superior
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
