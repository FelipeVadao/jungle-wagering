import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('from (contrato de entrada)', () => {
    it.each([
      ['25.00', '25.00'],
      ['25.5', '25.50'],
      ['25', '25.00'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('aceita "%s" e serializa com escala fixa 2 ("%s")', (input, expected) => {
      expect(brl(input).amount).toBe(expected);
    });

    it.each([
      ['NaN'],
      ['Infinity'],
      ['-Infinity'],
      ['1e3'],
      ['1E-2'],
      [''],
      [' '],
      ['10.999'],
      ['0.001'],
      ['-1.00'],
      ['+1.00'],
      ['01.00'],
      ['.50'],
      ['5.'],
      [' 5.00'],
      ['5,00'],
      ['1000000000000000000.00'],
    ])('rejeita "%s"', (input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    });

    it('rejeita number (nunca aceita ponto flutuante)', () => {
      expect(() =>
        Money.from({ amount: 25 as unknown as string, currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it.each([['brl'], ['BR'], ['BRLL'], [''], ['12A']])(
      'rejeita moeda inválida "%s"',
      (currency) => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
      },
    );
  });

  describe('aritmética exata', () => {
    it('soma sem erro de ponto flutuante (0.10 + 0.20 = 0.30)', () => {
      expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    });

    it('subtrai e pode produzir negativo internamente', () => {
      expect(brl('100.00').subtract(brl('30.50')).amount).toBe('69.50');
      expect(brl('1.00').subtract(brl('1.01')).amount).toBe('-0.01');
    });

    it('negate inverte o sinal', () => {
      expect(brl('5.25').negate().amount).toBe('-5.25');
      expect(brl('5.25').negate().negate().equals(brl('5.25'))).toBe(true);
    });

    it('valores grandes não perdem precisão', () => {
      expect(brl('999999999999999999.99').subtract(brl('0.01')).amount).toBe(
        '999999999999999999.98',
      );
    });

    it('é imutável: operações retornam novas instâncias', () => {
      const original = brl('10.00');
      const result = original.add(brl('5.00'));

      expect(original.amount).toBe('10.00');
      expect(result).not.toBe(original);
      expect(Object.isFrozen(original)).toBe(true);
    });
  });

  describe('consultas', () => {
    it('isZero / isPositive / isNegative', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('isLessThan / isGreaterThan / equals', () => {
      expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.01').isGreaterThan(brl('1.00'))).toBe(true);
      expect(brl('1.5').equals(brl('1.50'))).toBe(true);
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s entre moedas diferentes lança erro de domínio', (_name, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    });
  });

  it('toJSON devolve MoneyProps e toString é legível', () => {
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(JSON.stringify({ money: brl('1') })).toBe('{"money":{"amount":"1.00","currency":"BRL"}}');
    expect(brl('25.5').toString()).toBe('25.50 BRL');
  });
});
