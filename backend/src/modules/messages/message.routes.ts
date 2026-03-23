import { Router } from "express";
import { postMessage } from "./message.controller";

export const messageRouter = Router();

messageRouter.post("/", postMessage);
