import express from "express";
import { debugRouter } from "./modules/debug/debug.routes";
import { messageRouter } from "./modules/messages/message.routes";

export const createApp = () => {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/debug", debugRouter);
  app.use("/message", messageRouter);

  return app;
};
