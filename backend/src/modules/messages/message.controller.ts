import { Request, Response } from "express";
import { messageService } from "./message.service";

export const postMessage = async (req: Request, res: Response) => {
  const { message, userId } = req.body as { message?: string; userId?: string };

  if (!message || typeof message !== "string") {
    return res.status(400).json({
      success: false,
      error: "El campo 'message' es requerido y debe ser texto."
    });
  }

  const reply = await messageService.handleIncomingMessage({
    message,
    userId:
      typeof userId === "string" && userId.trim().length > 0
        ? userId
        : "demo-user"
  });

  return res.status(200).json({
    success: true,
    data: reply
  });
};
