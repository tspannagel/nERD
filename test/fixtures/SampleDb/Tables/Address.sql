CREATE TABLE dbo.Address (
    AddressId  int NOT NULL PRIMARY KEY,
    CustomerId int NOT NULL REFERENCES dbo.Customer (CustomerId) ON DELETE CASCADE,
    Street     nvarchar(200) NOT NULL,
    City       nvarchar(100) NOT NULL,
    Zip        varchar(10) NULL,
    Country    char(2) NOT NULL DEFAULT 'DE'
);
