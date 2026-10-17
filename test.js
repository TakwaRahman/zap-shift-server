const express = require("express");

const app = express();

app.get("/", (req, res) => {
  res.send("Hello");
});

app.listen(3000, "127.0.0.1", () => {
  console.log("Listening on http://127.0.0.1:3000");
});