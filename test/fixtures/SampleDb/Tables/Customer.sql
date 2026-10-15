CREATE TABLE [dbo].[Customer]
(
    [CustomerId]   INT            IDENTITY (1, 1) NOT NULL,
    [Name]         NVARCHAR (200) NOT NULL,
    [Email]        NVARCHAR (320) NULL,
    [CreatedAt]    DATETIME2 (3)  CONSTRAINT [DF_Customer_CreatedAt] DEFAULT (sysutcdatetime()) NOT NULL,
    [IsActive]     BIT            DEFAULT ((1)) NOT NULL,
    CONSTRAINT [PK_Customer] PRIMARY KEY CLUSTERED ([CustomerId] ASC),
    CONSTRAINT [UQ_Customer_Email] UNIQUE ([Email])
);
GO
CREATE NONCLUSTERED INDEX [IX_Customer_Name] ON [dbo].[Customer] ([Name]);
