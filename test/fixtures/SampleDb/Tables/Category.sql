CREATE TABLE [Sales].[Category] (
    [CategoryId] INT           NOT NULL PRIMARY KEY,
    [ParentId]   INT           NULL,
    [Name]       NVARCHAR (80) NOT NULL,
    CONSTRAINT [FK_Category_Parent] FOREIGN KEY ([ParentId]) REFERENCES [Sales].[Category] ([CategoryId])
);
