const http = require("http");

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function stopTestServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

module.exports = {
  startTestServer,
  stopTestServer
};
