const baseTool = {
  name: "Taladro",
  type: "Electrica",
  category: "Construccion",
  description: "Taladro percutor para pared",
  urlSrc: "https://example.com/taladro.jpg",
  state: "Disponible",
  material: "Acero",
  long: 32.5
};

function createTool(overrides = {}) {
  return {
    ...baseTool,
    ...overrides
  };
}

module.exports = {
  baseTool,
  createTool
};
