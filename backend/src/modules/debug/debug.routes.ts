import { Router } from "express";
import { getDebugOrders, getDebugState } from "./debug.controller";

export const debugRouter = Router();

debugRouter.get("/orders", getDebugOrders);
debugRouter.get("/state", getDebugState);
