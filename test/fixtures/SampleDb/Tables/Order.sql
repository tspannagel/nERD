CREATE TABLE [Sales].[Order] (
    [OrderId]    BIGINT          IDENTITY (1, 1) NOT NULL,
    [CustomerId] INT             NOT NULL,
    [OrderDate]  DATE            NOT NULL,
    [Status]     TINYINT         NOT NULL CONSTRAINT [CK_Order_Status] CHECK ([Status] BETWEEN 0 AND 5),
    [Total]      AS ([dbo].[fn_OrderTotal]([OrderId])),
    CONSTRAINT [PK_Order] PRIMARY KEY CLUSTERED ([OrderId] ASC)
);
GO
ALTER TABLE [Sales].[Order] WITH CHECK
    ADD CONSTRAINT [FK_Order_Customer] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customer] ([CustomerId]);
