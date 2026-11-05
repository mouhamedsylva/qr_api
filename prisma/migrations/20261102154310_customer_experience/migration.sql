-- AlterTable
ALTER TABLE `orders` ADD COLUMN `customerId` CHAR(36) NULL,
    ADD COLUMN `promoCode` VARCHAR(40) NULL,
    ADD COLUMN `promotionId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `promotions` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `type` ENUM('PERCENT', 'AMOUNT', 'BUY_X_GET_Y', 'FREE_ITEM') NOT NULL,
    `value` INTEGER NOT NULL DEFAULT 0,
    `buyQuantity` INTEGER NULL,
    `freeQuantity` INTEGER NULL,
    `menuItemId` CHAR(36) NULL,
    `minSubtotal` INTEGER NULL,
    `maxDiscount` INTEGER NULL,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `usageLimit` INTEGER NULL,
    `perCustomerLimit` INTEGER NULL,
    `usageCount` INTEGER NOT NULL DEFAULT 0,
    `customerId` CHAR(36) NULL,
    `source` ENUM('MANUAL', 'LOYALTY') NOT NULL DEFAULT 'MANUAL',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `promotions_customerId_idx`(`customerId`),
    UNIQUE INDEX `promotions_restaurantId_code_key`(`restaurantId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_redemptions` (
    `id` CHAR(36) NOT NULL,
    `promotionId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `customerId` CHAR(36) NULL,
    `customerPhone` VARCHAR(32) NULL,
    `discount` INTEGER NOT NULL,
    `releasedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `promotion_redemptions_orderId_key`(`orderId`),
    INDEX `promotion_redemptions_promotionId_customerId_idx`(`promotionId`, `customerId`),
    INDEX `promotion_redemptions_promotionId_customerPhone_idx`(`promotionId`, `customerPhone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loyalty_programs` (
    `restaurantId` CHAR(36) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `pointsPerUnit` INTEGER NOT NULL DEFAULT 1,
    `unitAmount` INTEGER NOT NULL DEFAULT 100,
    `expiryDays` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`restaurantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loyalty_rewards` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `pointsCost` INTEGER NOT NULL,
    `type` ENUM('PERCENT', 'AMOUNT', 'BUY_X_GET_Y', 'FREE_ITEM') NOT NULL,
    `value` INTEGER NOT NULL DEFAULT 0,
    `menuItemId` CHAR(36) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `loyalty_rewards_restaurantId_idx`(`restaurantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loyalty_accounts` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `points` INTEGER NOT NULL DEFAULT 0,
    `lifetimePoints` INTEGER NOT NULL DEFAULT 0,
    `lastActivityAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `loyalty_accounts_restaurantId_userId_key`(`restaurantId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loyalty_transactions` (
    `id` CHAR(36) NOT NULL,
    `accountId` CHAR(36) NOT NULL,
    `type` ENUM('EARN', 'REDEEM', 'EXPIRE', 'ADJUST', 'REVERSAL') NOT NULL,
    `points` INTEGER NOT NULL,
    `orderId` CHAR(36) NULL,
    `promotionId` CHAR(36) NULL,
    `note` VARCHAR(255) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `loyalty_transactions_accountId_createdAt_idx`(`accountId`, `createdAt`),
    INDEX `loyalty_transactions_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reviews` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `orderId` CHAR(36) NOT NULL,
    `customerId` CHAR(36) NULL,
    `authorName` VARCHAR(100) NULL,
    `rating` INTEGER NOT NULL,
    `comment` TEXT NULL,
    `status` ENUM('PUBLISHED', 'HIDDEN') NOT NULL DEFAULT 'PUBLISHED',
    `hiddenReason` VARCHAR(255) NULL,
    `reply` TEXT NULL,
    `repliedAt` DATETIME(3) NULL,
    `repliedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `reviews_orderId_key`(`orderId`),
    INDEX `reviews_restaurantId_status_createdAt_idx`(`restaurantId`, `status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_promotionId_fkey` FOREIGN KEY (`promotionId`) REFERENCES `promotions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotions` ADD CONSTRAINT `promotions_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotions` ADD CONSTRAINT `promotions_menuItemId_fkey` FOREIGN KEY (`menuItemId`) REFERENCES `menu_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotion_redemptions` ADD CONSTRAINT `promotion_redemptions_promotionId_fkey` FOREIGN KEY (`promotionId`) REFERENCES `promotions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_programs` ADD CONSTRAINT `loyalty_programs_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_rewards` ADD CONSTRAINT `loyalty_rewards_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_rewards` ADD CONSTRAINT `loyalty_rewards_menuItemId_fkey` FOREIGN KEY (`menuItemId`) REFERENCES `menu_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_accounts` ADD CONSTRAINT `loyalty_accounts_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_accounts` ADD CONSTRAINT `loyalty_accounts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_transactions` ADD CONSTRAINT `loyalty_transactions_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `loyalty_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
