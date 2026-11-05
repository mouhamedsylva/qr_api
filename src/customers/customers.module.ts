import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { OrdersModule } from '../orders/orders.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [AuthModule, OrdersModule, LoyaltyModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
