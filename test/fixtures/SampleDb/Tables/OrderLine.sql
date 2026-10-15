-- composite key + two foreign keys
CREATE TABLE [Sales].[OrderLine] (
    [OrderId]   BIGINT          NOT NULL,
    [LineNo]    SMALLINT        NOT NULL,
    [ProductId] INT             NOT NULL,
    [Quantity]  INT             NOT NULL,
    [UnitPrice] DECIMAL (18, 2) NOT NULL,
    CONSTRAINT [PK_OrderLine] PRIMARY KEY ([OrderId], [LineNo]),
    CONSTRAINT [FK_OrderLine_Order] FOREIGN KEY ([OrderId]) REFERENCES [Sales].[Order] ([OrderId]) ON DELETE CASCADE,
    CONSTRAINT [FK_OrderLine_Product] FOREIGN KEY ([ProductId]) REFERENCES [Sales].[Product]
);
