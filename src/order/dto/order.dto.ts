import { z } from 'zod';
import { OrderStatus as PrismaOrderStatus } from '@prisma/client';
import { OrderStatus as ProtoOrderStatus } from '@us-man-qa-sim/ecom-contracts/generated/order';

const absent = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema);

const zeroAsUnset = (v: unknown) => (v === 0 || v === null ? undefined : v);

const UUID = z.string().uuid();

// Product ids are MongoDB ObjectIds (product-service). Validating here turns a
// malformed id into INVALID_ARGUMENT before any downstream call.
const ObjectId = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex ObjectId');

// Same limits as the gateway's CreateOrderDto. 100 items is also
// product-service's GetProductsByIds cap.
export const MAX_ITEMS_PER_ORDER = 100;
export const MAX_QUANTITY_PER_ITEM = 10_000;

const protoToPrismaStatus: Record<number, PrismaOrderStatus> = {
  [ProtoOrderStatus.ORDER_STATUS_PENDING]: 'PENDING',
  [ProtoOrderStatus.ORDER_STATUS_CONFIRMED]: 'CONFIRMED',
  [ProtoOrderStatus.ORDER_STATUS_SHIPPED]: 'SHIPPED',
  [ProtoOrderStatus.ORDER_STATUS_DELIVERED]: 'DELIVERED',
  [ProtoOrderStatus.ORDER_STATUS_CANCELLED]: 'CANCELLED',
};

// ORDER_STATUS_UNSPECIFIED (0) means "no filter"; any other value outside the
// enum is rejected rather than silently widening the query to every status.
const PrismaStatusFromProto = z
  .preprocess(zeroAsUnset, z.number().int().optional())
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const mapped = protoToPrismaStatus[v];
    if (!mapped) {
      ctx.addIssue({ code: 'custom', message: `unknown order status ${v}` });
      return z.NEVER;
    }
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

export const CreateOrderInputSchema = z.object({
  addressId: UUID,
  items: z
    .array(
      z.object({
        productId: ObjectId,
        quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_ITEM),
      }),
    )
    .min(1)
    .max(MAX_ITEMS_PER_ORDER)
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: 'duplicate productId; combine quantities into one line',
    }),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;

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

export const CancelOrderInputSchema = z.object({
  orderId: UUID,
  reason: z.string().max(500).optional(),
});
export type CancelOrderInput = z.infer<typeof CancelOrderInputSchema>;

export const ShipOrderInputSchema = z.object({
  orderId: UUID,
});
export type ShipOrderInput = z.infer<typeof ShipOrderInputSchema>;

export const DeliverOrderInputSchema = z.object({
  orderId: UUID,
});
export type DeliverOrderInput = z.infer<typeof DeliverOrderInputSchema>;
