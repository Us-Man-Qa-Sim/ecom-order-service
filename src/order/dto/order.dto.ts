import { z } from 'zod';
import { OrderStatus as PrismaOrderStatus } from '@prisma/client';
import { OrderStatus as ProtoOrderStatus } from '@us-man-qa-sim/ecom-contracts/generated/order';

const absent = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema);

const zeroAsUnset = (v: unknown) => (v === 0 || v === null ? undefined : v);

const UUID = z.string().uuid();

const protoToPrismaStatus: Record<number, PrismaOrderStatus> = {
  [ProtoOrderStatus.ORDER_STATUS_PENDING]: 'PENDING',
  [ProtoOrderStatus.ORDER_STATUS_CONFIRMED]: 'CONFIRMED',
  [ProtoOrderStatus.ORDER_STATUS_SHIPPED]: 'SHIPPED',
  [ProtoOrderStatus.ORDER_STATUS_DELIVERED]: 'DELIVERED',
  [ProtoOrderStatus.ORDER_STATUS_CANCELLED]: 'CANCELLED',
};

const PrismaStatusFromProto = z
  .preprocess(zeroAsUnset, z.number().int().optional())
  .transform((v) => {
    if (v === undefined) return undefined;
    const mapped = protoToPrismaStatus[v];
    if (!mapped) return undefined;
    return mapped;
  });

const PaginationInput = absent(
  z
    .object({
      page: z.preprocess(zeroAsUnset, z.number().int().min(1).default(1)),
      pageSize: z.preprocess(zeroAsUnset, z.number().int().min(1).max(100).default(20)),
    })
    .default({ page: 1, pageSize: 20 }),
);

export const GetOrderInputSchema = z.object({
  orderId: UUID,
});
export type GetOrderInput = z.infer<typeof GetOrderInputSchema>;

export const ListMyOrdersInputSchema = z.object({
  pagination: PaginationInput,
  status: PrismaStatusFromProto,
});
export type ListMyOrdersInput = z.infer<typeof ListMyOrdersInputSchema>;

export const ListAllOrdersInputSchema = z.object({
  pagination: PaginationInput,
  status: PrismaStatusFromProto,
  userId: z.string().trim().min(1).optional(),
});
export type ListAllOrdersInput = z.infer<typeof ListAllOrdersInputSchema>;
