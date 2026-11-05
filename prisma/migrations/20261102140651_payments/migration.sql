-- AlterTable
ALTER TABLE `orders` ADD COLUMN `paidAt` DATETIME(3) NULL,
    ADD COLUMN `receiptNumber` INTEGER NULL,
    MODIFY `paymentStatus` ENUM('UNPAID', 'PENDING', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE `restaurants` ADD COLUMN `receiptSeq` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `stripeAccountId` VARCHAR(64) NULL,
    ADD COLUMN `stripeChargesEnabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `payments` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `provider` ENUM('CASH', 'STRIPE', 'SANDBOX') NOT NULL,
    `method` ENUM('CASH', 'CARD', 'MOBILE_MONEY') NOT NULL,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `amount` INTEGER NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `applicationFee` INTEGER NOT NULL DEFAULT 0,
    `refundedAmount` INTEGER NOT NULL DEFAULT 0,
    `providerRef` VARCHAR(100) NULL,
    `operator` VARCHAR(30) NULL,
    `payerPhone` VARCHAR(32) NULL,
    `idempotencyKey` VARCHAR(100) NOT NULL,
    `failureReason` VARCHAR(255) NULL,
    `collectedById` CHAR(36) NULL,
    `succeededAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payments_orderId_idx`(`orderId`),
    INDEX `payments_restaurantId_createdAt_idx`(`restaurantId`, `createdAt`),
    UNIQUE INDEX `payments_restaurantId_idempotencyKey_key`(`restaurantId`, `idempotencyKey`),
    UNIQUE INDEX `payments_provider_providerRef_key`(`provider`, `providerRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `amount` INTEGER NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `providerRef` VARCHAR(100) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `refunds_paymentId_idx`(`paymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_webhook_events` (
    `id` CHAR(36) NOT NULL,
    `provider` ENUM('CASH', 'STRIPE', 'SANDBOX') NOT NULL,
    `eventId` VARCHAR(100) NOT NULL,
    `type` VARCHAR(100) NOT NULL,
    `payload` JSON NOT NULL,
    `processedAt` DATETIME(3) NULL,
    `error` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_webhook_events_provider_eventId_key`(`provider`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
