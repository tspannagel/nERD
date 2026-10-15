CREATE TABLE [Sales].[Product] (
    [ProductId]  INT             NOT NULL,
    [Sku]        VARCHAR (32)    NOT NULL,
    [Title]      NVARCHAR (MAX)  NOT NULL,
    [Price]      DECIMAL (18, 2) NOT NULL,
    [CategoryId] INT             NULL,
    CONSTRAINT [PK_Product] PRIMARY KEY ([ProductId]),
    CONSTRAINT [FK_Product_Category] FOREIGN KEY ([CategoryId]) REFERENCES [Sales].[Category] ([CategoryId])
);
