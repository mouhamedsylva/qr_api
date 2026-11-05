-- AlterTable
ALTER TABLE `restaurants` ADD COLUMN `orderSeq` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `orders` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `tableId` CHAR(36) NULL,
    `mode` ENUM('DINE_IN', 'TAKEAWAY') NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `source` ENUM('CUSTOMER', 'STAFF') NOT NULL,
    `paymentStatus` ENUM('UNPAID', 'PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') NOT NULL DEFAULT 'UNPAID',
    `idempotencyKey` VARCHAR(100) NOT NULL,
    `trackingTokenHash` CHAR(64) NOT NULL,
    `customerName` VARCHAR(100) NULL,
    `customerPhone` VARCHAR(32) NULL,
    `notes` VARCHAR(500) NULL,
    `currency` VARCHAR(3) NOT NULL,
    `subtotal` INTEGER NOT NULL,
    `discountTotal` INTEGER NOT NULL DEFAULT 0,
    `taxTotal` INTEGER NOT NULL,
    `serviceFee` INTEGER NOT NULL,
    `tipAmount` INTEGER NOT NULL DEFAULT 0,
    `total` INTEGER NOT NULL,
    `taxRateBp` INTEGER NOT NULL,
    `pricesIncludeTax` BOOLEAN NOT NULL,
    `serviceFeeBp` INTEGER NOT NULL,
    `estimatedReadyAt` DATETIME(3) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `readyAt` DATETIME(3) NULL,
    `servedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(255) NULL,
    `cancelledBy` ENUM('CUSTOMER', 'STAFF') NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `orders_restaurantId_status_createdAt_idx`(`restaurantId`, `status`, `createdAt`),
    INDEX `orders_restaurantId_createdAt_idx`(`restaurantId`, `createdAt`),
    INDEX `orders_tableId_idx`(`tableId`),
    UNIQUE INDEX `orders_restaurantId_idempotencyKey_key`(`restaurantId`, `idempotencyKey`),
    UNIQUE INDEX `orders_restaurantId_number_key`(`restaurantId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_items` (
    `id` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `menuItemId` CHAR(36) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `unitPrice` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL,
    `options` JSON NOT NULL,
    `notes` VARCHAR(255) NULL,
    `lineTotal` INTEGER NOT NULL,
    `batch` INTEGER NOT NULL DEFAULT 1,
    `batchKey` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `order_items_orderId_idx`(`orderId`),
    INDEX `order_items_orderId_batchKey_idx`(`orderId`, `batchKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `realtime_events` (
    `seq` INTEGER NOT NULL AUTO_INCREMENT,
    `restaurantId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NULL,
    `type` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `realtime_events_restaurantId_seq_idx`(`restaurantId`, `seq`),
    INDEX `realtime_events_orderId_seq_idx`(`orderId`, `seq`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_tableId_fkey` FOREIGN KEY (`tableId`) REFERENCES `dining_tables`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_menuItemId_fkey` FOREIGN KEY (`menuItemId`) REFERENCES `menu_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `realtime_events` ADD CONSTRAINT `realtime_events_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
