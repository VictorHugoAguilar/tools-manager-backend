const MODULES = Object.freeze([
    { id: "dashboard", name: "Tablero", description: "Tablero de herramientas.", icon: "⌂", route: "/tablero", category: "Herramientas", permission: "module:dashboard" },
    { id: "inventory", name: "Inventario", description: "Inventario de herramientas.", icon: "▤", route: "/inventario", category: "Herramientas", permission: "module:inventory" },
    { id: "storage", name: "Almacenamiento", description: "Cajas y productos almacenados.", icon: "▣", route: "/almacenamiento", category: "Almacenamiento", permission: "module:storage" },
    { id: "workshopStorage", name: "Inventario taller", description: "Almacenamiento y materiales del taller.", icon: "▤", route: "/almacenamiento-taller", category: "Almacenamiento", permission: "module:workshop-storage" },
    { id: "taskBoard", name: "Listas de tareas", description: "Tablero de listas de tareas.", icon: "☷", route: "/listas-tareas", category: "Organización", permission: "module:task-board" },
    { id: "todoList", name: "Tareas", description: "Proyectos y tareas personales o compartidas.", icon: "✓", route: "/todo-list", category: "Organización", permission: "module:todo-list" },
    { id: "drawing", name: "Dibujar", description: "Documentos y pizarras colaborativas.", icon: "✎", route: "/dibujar", category: "Herramientas", permission: "module:drawing" },
    { id: "exams", name: "Exámenes", description: "Exámenes de práctica.", icon: "☑", route: "/examenes", category: "Aprendizaje", permission: "module:exams" },
    { id: "categories", name: "Categorías", description: "Resumen de herramientas por categoría.", icon: "◫", route: "/categorias", category: "Herramientas", permission: "module:categories" },
    { id: "reports", name: "Reportes", description: "Análisis y reportes de herramientas.", icon: "◧", route: "/reportes", category: "Herramientas", permission: "module:reports" },
    { id: "monitoring", name: "Monitorización", description: "Salud y actividad de la aplicación.", icon: "⌁", route: "/monitorizacion", category: "Administración", permission: "monitoring:app" },
    { id: "repairs", name: "Arreglos", description: "Seguimiento de reparaciones.", icon: "🛠", route: "/arreglos", category: "Herramientas", permission: "module:repairs" },
    { id: "technicians", name: "Técnicos", description: "Gestión de técnicos.", icon: "👷", route: "/tecnicos", category: "Herramientas", permission: "module:technicians" },
    { id: "settings", name: "Configuración", description: "Preferencias y catálogos de la aplicación.", icon: "⚙", route: "/configuracion", category: "Administración", permission: "module:settings" },
    { id: "users", name: "Gestión de usuarios", description: "Administración de cuentas.", icon: "♙", route: "/usuarios", category: "Administración", permission: "users:manage" }
].map((module) => Object.freeze({ ...module, active: true })));

module.exports = { MODULES };
