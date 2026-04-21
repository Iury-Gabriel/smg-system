const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const routes = require("./routes");

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));
app.use("/public", express.static(path.join(__dirname, "..", "public")));

app.use("/api", routes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not Found",
  });
});

app.use((error, req, res, next) => {
  const statusCode = Number(error?.statusCode || 500);
  res.status(statusCode).json({
    success: false,
    error: error?.message || "Internal Server Error",
  });
});

module.exports = app;
