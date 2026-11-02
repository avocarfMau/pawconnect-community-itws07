import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MyStrayReportsPage } from './my-stray-reports.page';

describe('MyStrayReportsPage', () => {
  let component: MyStrayReportsPage;
  let fixture: ComponentFixture<MyStrayReportsPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(MyStrayReportsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
