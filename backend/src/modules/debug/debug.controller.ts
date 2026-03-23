import { Request, Response } from "express";
import { checkoutStateService } from "../../services/checkout/checkout-state.service";
import { ordersService } from "../../services/checkout/orders.service";
import { conversationMemoryService } from "../../services/conversation/conversation-memory.service";

export const getDebugOrders = (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      count: ordersService.getAll().length,
      orders: ordersService.getAll()
    }
  });
};

export const getDebugState = (_req: Request, res: Response) => {
  const state = checkoutStateService.getAll();

  res.status(200).json({
    success: true,
    data: {
      count: Object.keys(state).length,
      users: state,
      memory: conversationMemoryService.getAll()
    }
  });
};
